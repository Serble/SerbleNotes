using Microsoft.AspNetCore.Mvc;
using SerbleNotes.Backend.Config;
using SerbleNotes.Backend.Database.Schema;
using SerbleNotes.Backend.Schema;
using SerbleNotes.Backend.Services;
using SerbleNotes.Backend.Tests.Support;

namespace SerbleNotes.Backend.Tests;

/// <summary>
/// The resource limits, which are a different question from the "inform, never forbid" rule: they
/// protect the service and the other people on it rather than second-guessing what someone wants
/// with their own notes.
///
/// What is worth pinning is the arithmetic at the edges - a limit that refuses the write that would
/// exactly reach it is off by one in the direction users notice - and that the bill goes to the
/// vault's owner rather than whoever happens to be typing.
/// </summary>
public class LimitsTests {

    private static CreateVersionRequest Payload(int bytes, string id = "v2") {
        return new CreateVersionRequest {
            Id = id, ParentId = "version-1", IsSnapshot = false,
            Payload = Convert.ToBase64String(new byte[bytes])
        };
    }

    [Fact]
    public void Minus_one_means_unlimited_everywhere_it_can_appear() {
        Assert.True(UserLimits.Within(long.MaxValue, -1));
        Assert.True(UserLimits.Within(0, -1));
    }

    [Fact]
    public void A_limit_allows_the_value_that_exactly_reaches_it() {
        // Within is asked about the state *after* the write, so "at the limit" is allowed and one
        // more is not. Getting this backwards costs a user the last note they are entitled to.
        Assert.True(UserLimits.Within(100, 100));
        Assert.False(UserLimits.Within(101, 100));
    }

    [Fact]
    public async Task A_write_that_exactly_reaches_the_storage_limit_is_allowed() {
        World world = new() { Settings = new GeneralSettings { MaxStorageBytes = 105 } };
        Vault vault = world.GiveVault();
        world.GiveNote(vault);            // 5 bytes of "hello"

        ActionResult<NoteVersion> result = await world.NotesController().CreateVersion("note-1", Payload(100));

        Assert.Equal(200, World.StatusOf(result.Result!));
        Assert.Equal(105, vault.StorageBytes);
    }

    [Fact]
    public async Task One_byte_past_the_storage_limit_is_refused_and_stores_nothing() {
        World world = new() { Settings = new GeneralSettings { MaxStorageBytes = 105 } };
        Vault vault = world.GiveVault();
        world.GiveNote(vault);

        ActionResult<NoteVersion> result = await world.NotesController().CreateVersion("note-1", Payload(101));

        Assert.Equal(403, World.StatusOf(result.Result!));
        Assert.Equal(5, vault.StorageBytes);
        Assert.Single(world.Versions.Versions);
    }

    [Fact]
    public async Task Storage_is_counted_across_every_vault_the_owner_has() {
        World world = new() { Settings = new GeneralSettings { MaxStorageBytes = 200 } };
        Vault first = world.GiveVault("vault-1");
        Vault second = world.GiveVault("vault-2");
        world.GiveNote(second, "other-note", "other-version");
        second.StorageBytes = 195;
        world.GiveNote(first);

        ActionResult<NoteVersion> result = await world.NotesController().CreateVersion("note-1", Payload(50));

        // The other vault's bytes count. A per-vault limit would let an account hold a hundred times
        // the quota by spreading it out.
        Assert.Equal(403, World.StatusOf(result.Result!));
    }

    [Fact]
    public async Task A_deleted_vault_stops_counting_against_the_quota() {
        World world = new() { Settings = new GeneralSettings { MaxStorageBytes = 200 } };
        Vault old = world.GiveVault("vault-old");
        old.StorageBytes = 195;
        Vault current = world.GiveVault("vault-1");
        world.GiveNote(current);

        await world.VaultsController().DeleteVault(old.Id);
        ActionResult<NoteVersion> result = await world.NotesController().CreateVersion("note-1", Payload(50));

        Assert.Equal(200, World.StatusOf(result.Result!));
    }

    [Fact]
    public async Task The_bill_goes_to_the_vaults_owner_not_the_caller() {
        World world = new() { Settings = new GeneralSettings { MaxStorageBytes = 10 } };
        Vault vault = world.GiveVault("vault-1", World.Owner);
        world.GiveNote(vault);
        vault.StorageBytes = 10;

        // A second holder, writing into somebody else's full vault. Charging the caller would let a
        // shared vault spend whichever member happened to be typing.
        world.Vaults.Keys[(vault.Id, World.Stranger)] = new VaultKey {
            VaultId = vault.Id, UserId = World.Stranger, WrappedKey = "k",
            CreatedAt = DateTime.UtcNow, VaultNavigation = vault
        };

        ActionResult<NoteVersion> result =
            await world.NotesController(World.Stranger).CreateVersion("note-1", Payload(1));

        Assert.Equal(403, World.StatusOf(result.Result!));
    }

    [Fact]
    public async Task A_payload_over_the_per_save_cap_is_refused_before_the_storage_check() {
        World world = new() {
            Settings = new GeneralSettings { MaxVersionPayloadBytes = 10, MaxStorageBytes = -1 }
        };
        Vault vault = world.GiveVault();
        world.GiveNote(vault);

        ActionResult<NoteVersion> result = await world.NotesController().CreateVersion("note-1", Payload(11));

        // 400 rather than 403: this one is about the request being too big, not the account being
        // full, and the client shows a different thing for each.
        Assert.Equal(400, World.StatusOf(result.Result!));
    }

    [Fact]
    public async Task The_note_limit_counts_tombstones_because_they_are_still_rows() {
        World world = new() { Settings = new GeneralSettings { MaxNotesPerVault = 1 } };
        Vault vault = world.GiveVault();
        world.GiveNote(vault);
        await world.NotesController().DeleteNote("note-1");

        ActionResult<Note> result = await world.VaultsController().CreateNote(vault.Id, new CreateNoteRequest {
            Id = "note-2", Name = "bmV3",
            InitialVersion = new CreateVersionRequest { Id = "v9", IsSnapshot = true, Payload = World.Sealed("x") }
        });

        Assert.Equal(403, World.StatusOf(result.Result!));
    }

    [Fact]
    public async Task The_vault_limit_counts_only_live_vaults() {
        World world = new() { Settings = new GeneralSettings { MaxVaultsPerUser = 1 } };
        Vault first = world.GiveVault();

        ActionResult<VaultResponse> blocked = await world.VaultsController().CreateVault(new CreateVaultRequest {
            Name = "Second", Encrypted = false, WrappedKey = "w"
        });
        Assert.Equal(403, World.StatusOf(blocked.Result!));

        await world.VaultsController().DeleteVault(first.Id);
        ActionResult<VaultResponse> allowed = await world.VaultsController().CreateVault(new CreateVaultRequest {
            Name = "Second", Encrypted = false, WrappedKey = "w"
        });
        Assert.Equal(200, World.StatusOf(allowed.Result!));
    }

    [Fact]
    public async Task A_refusal_names_the_limit_that_refused_it() {
        World world = new() { Settings = new GeneralSettings { MaxStorageBytes = 5 } };
        Vault vault = world.GiveVault();
        world.GiveNote(vault);

        ActionResult<NoteVersion> result = await world.NotesController().CreateVersion("note-1", Payload(10));
        string body = System.Text.Json.JsonSerializer.Serialize(World.ValueOf(result));

        // Never "0 MB", which is what dividing straight to megabytes produced and which tells
        // somebody their note is too big to fit in nothing.
        Assert.DoesNotContain("0 MB", body);
        Assert.Contains("5 bytes", body);
    }

    [Fact]
    public async Task Unlimited_settings_refuse_nothing() {
        World world = new() {
            Settings = new GeneralSettings {
                MaxStorageBytes = -1, MaxNotesPerVault = -1, MaxVaultsPerUser = -1, MaxVersionPayloadBytes = -1
            }
        };
        Vault vault = world.GiveVault();
        world.GiveNote(vault);

        ActionResult<NoteVersion> result = await world.NotesController().CreateVersion("note-1", Payload(1_000_000));

        Assert.Equal(200, World.StatusOf(result.Result!));
    }
}
