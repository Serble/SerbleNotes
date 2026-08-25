using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using SerbleNotes.Backend.Config;
using SerbleNotes.Backend.Controllers;
using SerbleNotes.Backend.Database.Schema;
using SerbleNotes.Backend.Services;
using SerbleNotes.Backend.Services.Impl;

namespace SerbleNotes.Backend.Tests.Support;

/// <summary>
/// One backend, wired up the way Program.cs wires it, with the repos in memory.
///
/// Tests build controllers from here rather than newing them up, so that a change to what a
/// controller depends on is one edit and not thirty.
/// </summary>
public class World {
    public readonly FakeVaultRepo Vaults = new();
    public readonly FakeNoteRepo Notes = new();
    public readonly FakeVersionRepo Versions = new();
    public readonly FakeSyncNotifier Sync = new();

    public GeneralSettings Settings { get; init; } = new();

    public SerbleApiSettings SerbleApi { get; init; } = new() {
        BaseUrl = "https://api.serble.test/",
        ClientId = "serble-app-id",
        ClientSecret = "serble-client-secret"
    };

    public IUserLimits Limits => new ConfiguredUserLimits(Options.Create(Settings), Vaults, Notes);
    public IVaultAccess Access => new VaultAccessService(Vaults, Notes);
    public INotesService NoteService => new NotesService(Vaults, Notes, Versions, Sync);

    public const string Owner = "owner-user";
    public const string Stranger = "stranger-user";

    public VaultsController VaultsController(string userId = Owner, string? deviceId = null) {
        return Wire(new VaultsController(Vaults, Notes, Versions, Access, NoteService, Sync, Limits), userId, deviceId);
    }

    public NotesController NotesController(string userId = Owner, string? deviceId = null) {
        return Wire(new NotesController(Versions, Access, NoteService, Limits), userId, deviceId);
    }

    /// <summary>
    /// Unlike everything else here this one is anonymous, so it is given no user - a client asks it
    /// before it has a token at all.
    /// </summary>
    public ConfigController ConfigController() {
        return new ConfigController(Options.Create(SerbleApi)) {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() }
        };
    }

    private static T Wire<T>(T controller, string userId, string? deviceId) where T : ControllerBase {
        DefaultHttpContext http = new() {
            User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier, userId)], "test"))
        };

        if (deviceId != null) {
            http.Request.Headers["X-Device-Id"] = deviceId;
        }

        controller.ControllerContext = new ControllerContext { HttpContext = http };
        return controller;
    }

    /// <summary>A vault owned by <see cref="Owner"/>, with the owner's key row, as creation makes it.</summary>
    public Vault GiveVault(string id = "vault-1", string ownerId = Owner, bool encrypted = true) {
        DateTime now = DateTime.UtcNow;
        Vault vault = new() {
            Id = id,
            Name = "A vault",
            OwnerId = ownerId,
            Encrypted = encrypted,
            Cursor = 0,
            StorageBytes = 0,
            CreatedAt = now,
            UpdatedAt = now
        };
        Vaults.Vaults[id] = vault;
        Vaults.Keys[(id, ownerId)] = new VaultKey {
            VaultId = id,
            UserId = ownerId,
            WrappedKey = "wrapped-for-" + ownerId,
            KdfSalt = encrypted ? "salt" : null,
            KdfParams = encrypted ? "{}" : null,
            CreatedAt = now,
            VaultNavigation = vault
        };
        return vault;
    }

    /// <summary>A note with one snapshot version, as CreateNote leaves it.</summary>
    public (Note Note, NoteVersion Version) GiveNote(
        Vault vault, string noteId = "note-1", string versionId = "version-1", string payload = "hello") {
        DateTime now = DateTime.UtcNow;
        byte[] bytes = System.Text.Encoding.UTF8.GetBytes(payload);

        Note note = new() {
            Id = noteId,
            VaultId = vault.Id,
            Name = "c2VhbGVk",
            HeadVersionId = versionId,
            Cursor = ++vault.Cursor,
            CreatedAt = now,
            UpdatedAt = now
        };
        Notes.Notes[noteId] = note;

        NoteVersion version = new() {
            Id = versionId,
            NoteId = noteId,
            VaultId = vault.Id,
            ParentId = null,
            IsSnapshot = true,
            Payload = bytes,
            Size = bytes.Length,
            Cursor = note.Cursor,
            CreatedAt = now
        };
        Versions.Versions[versionId] = version;
        vault.StorageBytes += bytes.Length;

        return (note, version);
    }

    /// <summary>Base64 of <paramref name="text"/>, which is what a client sends as a payload.</summary>
    public static string Sealed(string text) {
        return Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(text));
    }

    /// <summary>The status an ActionResult carries, whichever kind of result it happens to be.</summary>
    public static int StatusOf(IActionResult result) {
        return result switch {
            ObjectResult obj => obj.StatusCode ?? 200,
            StatusCodeResult code => code.StatusCode,
            _ => 200
        };
    }

    /// <summary>The value an ActionResult carries, unwrapped from whichever wrapper it is in.</summary>
    public static object? ValueOf<T>(ActionResult<T> result) {
        return result.Result switch {
            ObjectResult obj => obj.Value,
            _ => result.Value
        };
    }
}
