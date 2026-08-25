using Microsoft.AspNetCore.Mvc;
using SerbleNotes.Backend.Config;
using SerbleNotes.Backend.Database.Schema;
using SerbleNotes.Backend.Schema;
using SerbleNotes.Backend.Tests.Support;

namespace SerbleNotes.Backend.Tests;

/// <summary>
/// Vaults, and the key rows that are what access to one means.
///
/// The wire shape matters as much as the storage here: key material moved off the vault row into
/// <see cref="VaultKey"/> so a vault can one day have more than one holder, and the whole point of
/// <see cref="VaultResponse"/> is that no client had to learn about it.
/// </summary>
public class VaultTests {

    [Fact]
    public async Task Creating_a_vault_writes_the_owners_key_as_its_own_row() {
        World world = new();

        ActionResult<VaultResponse> result = await world.VaultsController().CreateVault(new CreateVaultRequest {
            Name = "Notes", Encrypted = true, WrappedKey = "wrapped", KdfSalt = "salt", KdfParams = "{}"
        });

        VaultResponse response = Assert.IsType<VaultResponse>(World.ValueOf(result));
        VaultKey key = world.Vaults.Keys[(response.Id, World.Owner)];

        Assert.Equal("wrapped", key.WrappedKey);
        Assert.Equal("salt", key.KdfSalt);
        Assert.Equal(World.Owner, world.Vaults.Vaults[response.Id].OwnerId);
    }

    [Fact]
    public async Task The_response_carries_the_callers_own_key_beside_the_vault() {
        World world = new();
        Vault vault = world.GiveVault();
        world.Vaults.Keys[(vault.Id, World.Stranger)] = new VaultKey {
            VaultId = vault.Id, UserId = World.Stranger, WrappedKey = "wrapped-for-stranger",
            CreatedAt = DateTime.UtcNow, VaultNavigation = vault
        };

        VaultResponse mine = Assert.IsType<VaultResponse>(
            World.ValueOf(await world.VaultsController(World.Owner).GetVault(vault.Id)));
        VaultResponse theirs = Assert.IsType<VaultResponse>(
            World.ValueOf(await world.VaultsController(World.Stranger).GetVault(vault.Id)));

        // Never anybody else's: a shared vault must not hand each member the other's wrapped key.
        Assert.Equal("wrapped-for-owner-user", mine.WrappedKey);
        Assert.Equal("wrapped-for-stranger", theirs.WrappedKey);
    }

    [Fact]
    public async Task Changing_the_password_rewraps_the_key_row_and_rewrites_nothing_else() {
        World world = new();
        Vault vault = world.GiveVault();
        world.GiveNote(vault);
        long cursorBefore = vault.Cursor;
        byte[] payloadBefore = world.Versions.Versions["version-1"].Payload;

        await world.VaultsController().ChangeVaultPassword(vault.Id, new ChangeVaultPasswordRequest {
            WrappedKey = "rewrapped", KdfSalt = "new-salt", KdfParams = "{\"iterations\":4}"
        });

        // The vault key inside the blob is the same key, so nothing in the vault is rewritten and no
        // device that already holds it has to do anything - which is why the cursor must not move.
        Assert.Equal("rewrapped", world.Vaults.Keys[(vault.Id, World.Owner)].WrappedKey);
        Assert.Equal("new-salt", world.Vaults.Keys[(vault.Id, World.Owner)].KdfSalt);
        Assert.Equal(cursorBefore, vault.Cursor);
        Assert.Equal(payloadBefore, world.Versions.Versions["version-1"].Payload);
        Assert.Equal("c2VhbGVk", world.Notes.Notes["note-1"].Name);
    }

    [Fact]
    public async Task An_unencrypted_vault_has_no_password_to_change() {
        World world = new();
        Vault vault = world.GiveVault(encrypted: false);

        ActionResult<VaultResponse> result = await world.VaultsController()
            .ChangeVaultPassword(vault.Id, new ChangeVaultPasswordRequest {
                WrappedKey = "w", KdfSalt = "s", KdfParams = "{}"
            });

        // Accepting one would leave a vault the server has already read looking as though it were
        // private, which is the one lie this product must not tell.
        Assert.Equal(400, World.StatusOf(result.Result!));
        Assert.Equal("wrapped-for-owner-user", world.Vaults.Keys[(vault.Id, World.Owner)].WrappedKey);
    }

    [Fact]
    public async Task An_encrypted_vault_must_bring_a_salt() {
        World world = new();

        ActionResult<VaultResponse> result = await world.VaultsController().CreateVault(new CreateVaultRequest {
            Name = "Notes", Encrypted = true, WrappedKey = "wrapped", KdfSalt = null
        });

        Assert.Equal(400, World.StatusOf(result.Result!));
    }

    [Fact]
    public async Task The_vault_list_is_what_the_caller_holds_a_key_to() {
        World world = new();
        world.GiveVault("mine");
        world.GiveVault("theirs", World.Stranger);

        ActionResult<IEnumerable<VaultResponse>> result = await world.VaultsController(World.Owner).GetVaults();
        VaultResponse[] listed = Assert.IsAssignableFrom<IEnumerable<VaultResponse>>(World.ValueOf(result)).ToArray();

        Assert.Equal("mine", Assert.Single(listed).Id);
    }

    [Fact]
    public async Task A_deleted_vault_leaves_the_list() {
        World world = new();
        Vault vault = world.GiveVault();
        await world.VaultsController().DeleteVault(vault.Id);

        ActionResult<IEnumerable<VaultResponse>> result = await world.VaultsController().GetVaults();

        Assert.Empty(Assert.IsAssignableFrom<IEnumerable<VaultResponse>>(World.ValueOf(result)));
    }

    [Fact]
    public async Task Changes_reports_the_cursor_of_the_rows_it_returned_not_the_vaults_own() {
        World world = new();
        Vault vault = world.GiveVault();
        world.GiveNote(vault);

        // A write that landed after the rows were read. Reporting the vault's cursor here would tell
        // the client it had seen this, and it would never come back for it.
        vault.Cursor = 500;

        ActionResult<ChangesResponse> result = await world.VaultsController().GetChanges(vault.Id, 0);
        ChangesResponse changes = Assert.IsType<ChangesResponse>(World.ValueOf(result));

        Assert.Equal(1, changes.Cursor);
        Assert.Single(changes.Notes);
    }

    [Fact]
    public async Task Changes_reports_the_highest_cursor_it_returned_not_the_lowest() {
        World world = new();
        Vault vault = world.GiveVault();
        world.GiveNote(vault, "note-1", "version-1");
        world.GiveNote(vault, "note-2", "version-2");
        world.GiveNote(vault, "note-3", "version-3");

        ChangesResponse changes = Assert.IsType<ChangesResponse>(
            World.ValueOf(await world.VaultsController().GetChanges(vault.Id, 0)));

        // The cursor a client sends next time. Reporting anything below the rows it was just given
        // would make it ask for them again forever; the highest is the only value that is both safe
        // and finite.
        Assert.Equal(3, changes.Cursor);
        Assert.Equal(3, changes.Notes.Length);
    }

    [Fact]
    public async Task A_rename_is_reported_by_changes_even_though_it_added_no_version() {
        World world = new();
        Vault vault = world.GiveVault();
        world.GiveNote(vault);

        await world.NotesController().RenameNote("note-1", new RenameNoteRequest { Name = "bmV3" });

        ChangesResponse changes = Assert.IsType<ChangesResponse>(
            World.ValueOf(await world.VaultsController().GetChanges(vault.Id, 1)));

        // A rename bumps the note's cursor and writes no version, so it is the *only* kind of change
        // where the highest cursor lives on a note rather than on a version. A client told a lower
        // number here never asks again, and the note keeps its old name on that device forever.
        Assert.Equal(2, changes.Cursor);
        Assert.Equal("bmV3", Assert.Single(changes.Notes).Name);
        Assert.Empty(changes.Versions);
    }

    [Fact]
    public async Task Creating_a_note_stores_it_and_tells_the_other_devices() {
        World world = new();
        Vault vault = world.GiveVault();
        world.Sync.Sent.Clear();

        await world.VaultsController(World.Owner, "phone").CreateNote(vault.Id, new CreateNoteRequest {
            Id = "note-9", Name = "bmV3",
            InitialVersion = new CreateVersionRequest { Id = "v9", IsSnapshot = true, Payload = World.Sealed("x") }
        });

        Note stored = Assert.IsType<Note>(await world.Notes.GetNote("note-9"));
        Assert.Equal("v9", stored.HeadVersionId);

        FakeSyncNotifier.Notification sent = Assert.Single(world.Sync.Sent);
        Assert.Equal("note-9", Assert.Single(sent.Notes).Id);
        Assert.Equal("v9", Assert.Single(sent.Versions).Id);
    }

    [Fact]
    public async Task A_live_vault_and_note_report_themselves_as_not_deleted() {
        World world = new();
        Vault vault = world.GiveVault();
        world.GiveNote(vault);

        // The wire flag is computed from a timestamp now. If it read the wrong way round, every live
        // row would arrive at the client as a tombstone and the vault would look empty.
        VaultResponse response = Assert.IsType<VaultResponse>(
            World.ValueOf(await world.VaultsController().GetVault(vault.Id)));

        Assert.False(response.Deleted);
        Assert.False(world.Notes.Notes["note-1"].Deleted);
    }

    [Fact]
    public async Task Deleting_a_vault_tells_the_other_devices() {
        World world = new();
        Vault vault = world.GiveVault();
        world.Sync.Sent.Clear();

        await world.VaultsController(World.Owner, "phone").DeleteVault(vault.Id);

        // Without this a second device keeps showing a vault that is gone until it is reloaded.
        FakeSyncNotifier.Notification sent = Assert.Single(world.Sync.Sent);
        Assert.Equal(vault.Id, sent.VaultId);
        Assert.Equal("phone", sent.OriginDeviceId);
    }

    [Fact]
    public async Task Creating_a_note_is_subject_to_the_payload_cap_as_well_as_the_note_count() {
        World world = new() {
            Settings = new GeneralSettings { MaxVersionPayloadBytes = 10, MaxNotesPerVault = -1 }
        };
        Vault vault = world.GiveVault();

        ActionResult<Note> result = await world.VaultsController().CreateNote(vault.Id, new CreateNoteRequest {
            Id = "note-9", Name = "bmV3",
            InitialVersion = new CreateVersionRequest {
                Id = "v9", IsSnapshot = true, Payload = Convert.ToBase64String(new byte[50])
            }
        });

        // A note's first version goes in through a different route from every later one, so the size
        // check has to be on both - otherwise the cap is bypassed by creating rather than appending.
        Assert.Equal(400, World.StatusOf(result.Result!));
        Assert.Empty(world.Notes.Notes);
    }

    [Fact]
    public async Task Changes_without_bodies_leaves_the_ciphertext_out_but_keeps_the_shape() {
        World world = new();
        Vault vault = world.GiveVault();
        world.GiveNote(vault);

        ChangesResponse metadata = Assert.IsType<ChangesResponse>(
            World.ValueOf(await world.VaultsController().GetChanges(vault.Id, 0, bodies: false)));
        ChangesResponse full = Assert.IsType<ChangesResponse>(
            World.ValueOf(await world.VaultsController().GetChanges(vault.Id, 0, bodies: true)));

        // The metadata form is what makes opening a vault cheap, and what lets the client work out
        // which payloads it actually needs - so the parent pointers and snapshot flags must survive.
        SyncVersion thin = Assert.Single(metadata.Versions);
        Assert.Null(thin.Payload);
        Assert.True(thin.IsSnapshot);
        Assert.Equal(5, thin.Size);
        Assert.NotNull(Assert.Single(full.Versions).Payload);
    }

    [Fact]
    public async Task Changes_carries_tombstones_so_an_offline_device_learns_of_a_delete() {
        World world = new();
        Vault vault = world.GiveVault();
        world.GiveNote(vault);
        await world.NotesController().DeleteNote("note-1");

        ChangesResponse changes = Assert.IsType<ChangesResponse>(
            World.ValueOf(await world.VaultsController().GetChanges(vault.Id, 0)));

        Assert.True(Assert.Single(changes.Notes).Deleted);
    }

    [Fact]
    public async Task Creating_a_note_refuses_an_id_that_is_already_taken() {
        World world = new();
        Vault vault = world.GiveVault();
        world.GiveNote(vault);

        ActionResult<Note> result = await world.VaultsController().CreateNote(vault.Id, new CreateNoteRequest {
            Id = "note-1", Name = "bmV3",
            InitialVersion = new CreateVersionRequest { Id = "v9", IsSnapshot = true, Payload = World.Sealed("x") }
        });

        Assert.Equal(409, World.StatusOf(result.Result!));
        Assert.Equal("c2VhbGVk", world.Notes.Notes["note-1"].Name);
    }

    [Fact]
    public async Task The_first_version_of_a_note_is_forced_to_be_a_parentless_snapshot() {
        World world = new();
        Vault vault = world.GiveVault();

        // A client claiming otherwise is wrong by construction - there is nothing to diff against.
        await world.VaultsController().CreateNote(vault.Id, new CreateNoteRequest {
            Id = "note-9", Name = "bmV3",
            InitialVersion = new CreateVersionRequest {
                Id = "v9", IsSnapshot = false, ParentId = "made-up", Payload = World.Sealed("x")
            }
        });

        NoteVersion initial = world.Versions.Versions["v9"];
        Assert.True(initial.IsSnapshot);
        Assert.Null(initial.ParentId);
    }
}
