using Microsoft.AspNetCore.Mvc;
using SerbleNotes.Backend.Database.Schema;
using SerbleNotes.Backend.Schema;
using SerbleNotes.Backend.Tests.Support;

namespace SerbleNotes.Backend.Tests;

/// <summary>
/// Appending to the version DAG: what the server accepts, what it refuses, and what it never hands
/// back.
///
/// Version ids are chosen by clients, because a note is created offline and synced later. That is
/// what makes this endpoint delicate: an id is a claim by an untrusted caller about a row that may
/// already exist somewhere they cannot see, and the two questions it asks about that id - "is this a
/// retry of a write to this note" and "does this id exist at all" - must not be collapsed into one.
/// They were once, and it returned another vault's row.
/// </summary>
public class VersionWriteTests {

    private static CreateVersionRequest Version(
        string id, string? parentId = null, bool snapshot = true, string text = "hello") {
        return new CreateVersionRequest {
            Id = id,
            ParentId = parentId,
            IsSnapshot = snapshot,
            Payload = World.Sealed(text)
        };
    }

    [Fact]
    public async Task A_retry_of_the_same_write_returns_the_row_rather_than_a_second_version() {
        World world = new();
        Vault vault = world.GiveVault();
        world.GiveNote(vault);

        CreateVersionRequest request = Version("v2", "version-1", snapshot: false, text: "diff");
        ActionResult<NoteVersion> first = await world.NotesController().CreateVersion("note-1", request);
        ActionResult<NoteVersion> again = await world.NotesController().CreateVersion("note-1", request);

        Assert.Equal(200, World.StatusOf(first.Result!));
        Assert.Equal(200, World.StatusOf(again.Result!));
        Assert.Equal(2, world.Versions.Versions.Count);

        // And the second write must not have been charged for again.
        Assert.Equal("hello".Length + "diff".Length, vault.StorageBytes);
    }

    [Fact]
    public async Task A_version_id_that_belongs_to_another_note_is_refused_and_never_returned() {
        World world = new();
        Vault mine = world.GiveVault();
        world.GiveNote(mine, "note-1", "version-1");

        Vault theirs = world.GiveVault("vault-2", World.Stranger);
        world.GiveNote(theirs, "their-note", "their-version", "THEIR SECRET");

        ActionResult<NoteVersion> result =
            await world.NotesController().CreateVersion("note-1", Version("their-version"));

        // 409, and the body is a message rather than their row. Returning the row is what this used
        // to do, and it handed over another user's ciphertext, note id and vault id.
        Assert.Equal(409, World.StatusOf(result.Result!));
        object? body = World.ValueOf(result);
        Assert.DoesNotContain("THEIR SECRET", System.Text.Json.JsonSerializer.Serialize(body));
        Assert.DoesNotContain("their-note", System.Text.Json.JsonSerializer.Serialize(body));
    }

    [Fact]
    public async Task A_colliding_id_does_not_overwrite_the_row_that_has_it() {
        World world = new();
        Vault mine = world.GiveVault();
        world.GiveNote(mine, "note-1", "version-1");

        Vault theirs = world.GiveVault("vault-2", World.Stranger);
        world.GiveNote(theirs, "their-note", "their-version", "THEIR SECRET");

        await world.NotesController().CreateVersion("note-1", Version("their-version", text: "mine"));

        NoteVersion untouched = world.Versions.Versions["their-version"];
        Assert.Equal("THEIR SECRET", System.Text.Encoding.UTF8.GetString(untouched.Payload));
        Assert.Equal("their-note", untouched.NoteId);
    }

    [Fact]
    public async Task A_parent_in_another_note_does_not_exist_as_far_as_this_note_is_concerned() {
        World world = new();
        Vault mine = world.GiveVault();
        world.GiveNote(mine, "note-1", "version-1");

        Vault theirs = world.GiveVault("vault-2", World.Stranger);
        world.GiveNote(theirs, "their-note", "their-version");

        ActionResult<NoteVersion> result = await world.NotesController()
            .CreateVersion("note-1", Version("v2", "their-version", snapshot: false));

        Assert.Equal(400, World.StatusOf(result.Result!));
        Assert.Equal(2, world.Versions.Versions.Count);
    }

    [Fact]
    public async Task A_diff_with_no_parent_is_refused() {
        World world = new();
        Vault vault = world.GiveVault();
        world.GiveNote(vault);

        // There would be nothing to apply it to. A stored diff whose base is unknown is the one
        // shape that rebuilds a plausible wrong document rather than failing.
        ActionResult<NoteVersion> result = await world.NotesController()
            .CreateVersion("note-1", Version("v2", null, snapshot: false));

        Assert.Equal(400, World.StatusOf(result.Result!));
    }

    [Fact]
    public async Task A_payload_that_is_not_base64_is_a_bad_request_rather_than_a_crash() {
        World world = new();
        Vault vault = world.GiveVault();
        world.GiveNote(vault);

        ActionResult<NoteVersion> result = await world.NotesController().CreateVersion("note-1",
            new CreateVersionRequest { Id = "v2", IsSnapshot = true, Payload = "not!valid!base64" });

        Assert.Equal(400, World.StatusOf(result.Result!));
        Assert.Single(world.Versions.Versions);
    }

    [Fact]
    public async Task A_sibling_parent_is_accepted_because_two_devices_offline_produce_forks() {
        World world = new();
        Vault vault = world.GiveVault();
        world.GiveNote(vault);

        // Both parented on the same version. The server must not "correct" this to a line: the DAG
        // is what makes concurrent editing representable, and the client merges it.
        await world.NotesController().CreateVersion("note-1", Version("v2", "version-1", snapshot: false, text: "a"));
        ActionResult<NoteVersion> sibling = await world.NotesController()
            .CreateVersion("note-1", Version("v3", "version-1", snapshot: false, text: "b"));

        Assert.Equal(200, World.StatusOf(sibling.Result!));
        Assert.Equal("version-1", world.Versions.Versions["v3"].ParentId);
    }

    [Fact]
    public async Task A_write_takes_exactly_one_cursor_and_stamps_it_on_the_rows() {
        World world = new();
        Vault vault = world.GiveVault();
        world.GiveNote(vault);
        world.Vaults.CursorsIssued.Clear();

        await world.NotesController().CreateVersion("note-1", Version("v2", "version-1", snapshot: false));

        // One value, on both the version and the note it moved. Two would leave a gap that makes a
        // client's contiguity check pull when it did not need to; none would make the write
        // invisible to sync entirely.
        long issued = Assert.Single(world.Vaults.CursorsIssued);
        Assert.Equal(issued, world.Versions.Versions["v2"].Cursor);
        Assert.Equal(issued, world.Notes.Notes["note-1"].Cursor);
    }

    [Fact]
    public async Task A_write_moves_the_head_and_charges_the_vault_for_the_bytes() {
        World world = new();
        Vault vault = world.GiveVault();
        world.GiveNote(vault);
        long before = vault.StorageBytes;

        await world.NotesController().CreateVersion("note-1", Version("v2", "version-1", snapshot: false, text: "abcdef"));

        Assert.Equal("v2", world.Notes.Notes["note-1"].HeadVersionId);
        Assert.Equal(before + 6, vault.StorageBytes);
        Assert.Equal(6, world.Versions.Versions["v2"].Size);
    }

    [Fact]
    public async Task The_payload_is_stored_as_the_bytes_the_base64_decoded_to() {
        World world = new();
        Vault vault = world.GiveVault();
        world.GiveNote(vault);

        // Bytes that are not text, because the payload is ciphertext and base64 is only how it
        // travels. Storing the encoded form is what this column used to do.
        byte[] raw = [0x00, 0xFF, 0x10, 0x80, 0x7F];
        await world.NotesController().CreateVersion("note-1", new CreateVersionRequest {
            Id = "v2", ParentId = "version-1", IsSnapshot = false, Payload = Convert.ToBase64String(raw)
        });

        Assert.Equal(raw, world.Versions.Versions["v2"].Payload);
    }

    [Fact]
    public async Task A_rename_appends_no_version_but_still_moves_the_cursor() {
        World world = new();
        Vault vault = world.GiveVault();
        world.GiveNote(vault);
        world.Vaults.CursorsIssued.Clear();

        await world.NotesController().RenameNote("note-1", new RenameNoteRequest { Name = "bmV3" });

        // History is a record of what a note said, not where it was filed - but the other devices
        // still have to hear about it, so it costs a cursor.
        Assert.Single(world.Versions.Versions);
        Assert.Single(world.Vaults.CursorsIssued);
        Assert.Equal("bmV3", world.Notes.Notes["note-1"].Name);
    }

    [Fact]
    public async Task Deleting_a_note_tombstones_it_and_frees_nothing() {
        World world = new();
        Vault vault = world.GiveVault();
        world.GiveNote(vault);
        long stored = vault.StorageBytes;

        await world.NotesController().DeleteNote("note-1");

        Note note = world.Notes.Notes["note-1"];
        Assert.NotNull(note.DeletedAt);
        Assert.True(note.Deleted, "the wire still carries a boolean");
        Assert.Single(world.Versions.Versions);
        Assert.Equal(stored, vault.StorageBytes);
    }

    [Fact]
    public async Task A_rename_and_a_delete_both_reach_the_other_devices() {
        World world = new();
        Vault vault = world.GiveVault();
        world.GiveNote(vault);
        world.Sync.Sent.Clear();

        await world.NotesController().RenameNote("note-1", new RenameNoteRequest { Name = "bmV3" });
        await world.NotesController().DeleteNote("note-1");

        // Neither appends a version, so the note row is the whole of the change - and a device that
        // never hears about it shows a note that has moved or gone until the next reload.
        Assert.Equal(2, world.Sync.Sent.Count);
        Assert.Equal("bmV3", Assert.Single(world.Sync.Sent[0].Notes).Name);
        Assert.True(Assert.Single(world.Sync.Sent[1].Notes).Deleted);
        Assert.All(world.Sync.Sent, sent => Assert.Empty(sent.Versions));
    }

    [Fact]
    public async Task A_write_that_is_not_persisted_would_not_be_there_to_read_back() {
        World world = new();
        Vault vault = world.GiveVault();
        world.GiveNote(vault);

        await world.NotesController().CreateVersion("note-1", Version("v2", "version-1", snapshot: false));

        // Read back through the repo rather than off the object that was written, which is the only
        // way this says anything: an in-place change to a row nobody saved looks identical otherwise.
        Note stored = (await world.Notes.GetNote("note-1"))!;
        Assert.Equal("v2", stored.HeadVersionId);
    }

    [Fact]
    public async Task The_device_that_wrote_is_named_on_the_notification_so_it_can_ignore_its_own_echo() {
        World world = new();
        Vault vault = world.GiveVault();
        world.GiveNote(vault);
        world.Sync.Sent.Clear();

        await world.NotesController(World.Owner, "phone")
            .CreateVersion("note-1", Version("v2", "version-1", snapshot: false));

        FakeSyncNotifier.Notification sent = Assert.Single(world.Sync.Sent);
        Assert.Equal("phone", sent.OriginDeviceId);
        Assert.Equal(World.Owner, sent.OwnerId);
        Assert.Single(sent.Versions);
    }
}
