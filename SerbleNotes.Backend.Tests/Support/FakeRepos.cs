using SerbleNotes.Backend.Database.Repos;
using SerbleNotes.Backend.Database.Schema;
using SerbleNotes.Backend.Schema;
using SerbleNotes.Backend.Services;

namespace SerbleNotes.Backend.Tests.Support;

/// <summary>
/// The database, in memory.
///
/// These stand in for the EF repos so that the logic above them can be tested without a MySQL
/// server. They are written to match what the real repos actually do rather than to be convenient -
/// a fake more permissive than the repo would hide exactly the bugs these tests exist to catch, and
/// the scoping in <see cref="FakeVersionRepo"/> is the whole reason several of them pass.
/// </summary>
public class FakeVaultRepo : IVaultRepo {
    public readonly Dictionary<string, Vault> Vaults = new();
    public readonly Dictionary<(string VaultId, string UserId), VaultKey> Keys = new();

    /// <summary>Every cursor handed out, so a test can assert one write took exactly one.</summary>
    public readonly List<long> CursorsIssued = [];

    public Task<Vault?> GetVault(string id) {
        return Task.FromResult(Vaults.GetValueOrDefault(id));
    }

    public Task<VaultKey[]> GetVaultsForUser(string userId) {
        return Task.FromResult(Keys.Values
            .Where(key => key.UserId == userId && key.VaultNavigation.DeletedAt == null)
            .OrderBy(key => key.VaultNavigation.CreatedAt)
            .ToArray());
    }

    public Task<int> CountVaultsForUser(string userId) {
        return Task.FromResult(Vaults.Values.Count(v => v.OwnerId == userId && v.DeletedAt == null));
    }

    public Task<long> TotalStorageForUser(string userId) {
        return Task.FromResult(Vaults.Values
            .Where(v => v.OwnerId == userId && v.DeletedAt == null)
            .Sum(v => v.StorageBytes));
    }

    public Task CreateVault(Vault vault) {
        Vaults[vault.Id] = vault;
        return Task.CompletedTask;
    }

    public Task MarkVaultDeleted(string vaultId, DateTime when) {
        if (Vaults.TryGetValue(vaultId, out Vault? vault)) {
            vault.DeletedAt = when;
            vault.UpdatedAt = when;
        }
        return Task.CompletedTask;
    }

    /// <summary>A copy, for the reason given on <see cref="FakeNoteRepo"/>.</summary>
    public Task<VaultKey?> GetKey(string vaultId, string userId) {
        VaultKey? key = Keys.GetValueOrDefault((vaultId, userId));
        if (key == null) {
            return Task.FromResult<VaultKey?>(null);
        }

        return Task.FromResult<VaultKey?>(new VaultKey {
            VaultId = key.VaultId,
            UserId = key.UserId,
            WrappedKey = key.WrappedKey,
            KdfSalt = key.KdfSalt,
            KdfParams = key.KdfParams,
            CreatedAt = key.CreatedAt,
            VaultNavigation = key.VaultNavigation
        });
    }

    public Task CreateKey(VaultKey key) {
        key.VaultNavigation = Vaults[key.VaultId];
        Keys[(key.VaultId, key.UserId)] = key;
        return Task.CompletedTask;
    }

    public Task UpdateKey(VaultKey key) {
        Keys[(key.VaultId, key.UserId)] = key;
        return Task.CompletedTask;
    }

    public Task<long> NextCursor(string vaultId, long storageDelta = 0) {
        Vault vault = Vaults[vaultId];
        vault.Cursor += 1;
        vault.StorageBytes += storageDelta;
        vault.UpdatedAt = DateTime.UtcNow;
        CursorsIssued.Add(vault.Cursor);
        return Task.FromResult(vault.Cursor);
    }
}

public class FakeNoteRepo : INoteRepo {
    public readonly Dictionary<string, Note> Notes = new();

    /// <summary>
    /// Reads hand back a copy, exactly as a database does.
    ///
    /// This is not fussiness. Handing back the stored instance means a caller that changes a note and
    /// then forgets to save it still "works", because it changed the row in place - so the test that
    /// was meant to prove the save happens proves nothing. Mutation testing found this: deleting
    /// `UpdateNote` from three call sites broke no test.
    /// </summary>
    private static Note Copy(Note note) {
        return new Note {
            Id = note.Id,
            VaultId = note.VaultId,
            Name = note.Name,
            HeadVersionId = note.HeadVersionId,
            Cursor = note.Cursor,
            CreatedAt = note.CreatedAt,
            UpdatedAt = note.UpdatedAt,
            DeletedAt = note.DeletedAt
        };
    }

    public Task<Note?> GetNote(string id) {
        Note? note = Notes.GetValueOrDefault(id);
        return Task.FromResult(note == null ? null : Copy(note));
    }

    public Task<Note[]> GetNotesInVault(string vaultId) {
        return Task.FromResult(Notes.Values
            .Where(n => n.VaultId == vaultId && n.DeletedAt == null)
            .OrderBy(n => n.CreatedAt)
            .ToArray());
    }

    public Task<Note[]> GetChangedNotes(string vaultId, long sinceCursor) {
        return Task.FromResult(Notes.Values
            .Where(n => n.VaultId == vaultId && n.Cursor > sinceCursor)
            .OrderBy(n => n.Cursor)
            .ToArray());
    }

    /// <summary>Tombstones included, as the repo counts them: they are still rows.</summary>
    public Task<int> CountNotesInVault(string vaultId) {
        return Task.FromResult(Notes.Values.Count(n => n.VaultId == vaultId));
    }

    public Task CreateNote(Note note) {
        Notes[note.Id] = Copy(note);
        return Task.CompletedTask;
    }

    public Task UpdateNote(Note note) {
        Notes[note.Id] = Copy(note);
        return Task.CompletedTask;
    }
}

public class FakeVersionRepo : IVersionRepo {
    public readonly Dictionary<string, NoteVersion> Versions = new();

    /// <summary>
    /// Scoped to the note, exactly as the real query is. A fake that ignored `noteId` would let every
    /// cross-note test pass while the server leaked.
    /// </summary>
    public Task<NoteVersion?> GetVersionInNote(string noteId, string id) {
        NoteVersion? version = Versions.GetValueOrDefault(id);
        return Task.FromResult(version?.NoteId == noteId ? version : null);
    }

    public Task<bool> VersionExists(string id) {
        return Task.FromResult(Versions.ContainsKey(id));
    }

    public Task<NoteVersion[]> GetVersionsForNote(string noteId) {
        return Task.FromResult(Versions.Values
            .Where(v => v.NoteId == noteId)
            .OrderBy(v => v.Cursor)
            .ToArray());
    }

    public Task<NoteVersion[]> GetVersionsByIds(string noteId, string[] ids) {
        HashSet<string> wanted = [.. ids];
        return Task.FromResult(Versions.Values
            .Where(v => v.NoteId == noteId && wanted.Contains(v.Id))
            .OrderBy(v => v.Cursor)
            .ToArray());
    }

    public Task<SyncVersion[]> GetChangedVersions(string vaultId, long sinceCursor, bool includePayloads) {
        return Task.FromResult(Versions.Values
            .Where(v => v.VaultId == vaultId && v.Cursor > sinceCursor)
            .OrderBy(v => v.Cursor)
            .Select(v => includePayloads ? SyncVersion.From(v) : SyncVersion.From(v, null))
            .ToArray());
    }

    public Task CreateVersion(NoteVersion version) {
        Versions[version.Id] = version;
        return Task.CompletedTask;
    }
}

/// <summary>Records what would have gone out over the sockets.</summary>
public class FakeSyncNotifier : ISyncNotifier {
    public record Notification(
        string OwnerId, string VaultId, long Cursor, string? OriginDeviceId, Note[] Notes, SyncVersion[] Versions);

    public readonly List<Notification> Sent = [];

    public Task NotifyVaultChanged(
        string ownerId, string vaultId, long cursor, string? originDeviceId, Note[] notes, SyncVersion[] versions) {
        Sent.Add(new Notification(ownerId, vaultId, cursor, originDeviceId, notes, versions));
        return Task.CompletedTask;
    }
}
