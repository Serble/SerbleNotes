using SerbleNotes.Backend.Database.Repos;
using SerbleNotes.Backend.Database.Schema;
using SerbleNotes.Backend.Schema;

namespace SerbleNotes.Backend.Services.Impl;

public class NotesService(
    IVaultRepo vaults,
    INoteRepo notes,
    IVersionRepo versions,
    ISyncNotifier sync) : INotesService {

    public async Task<Note> CreateNote(Vault vault, CreateNoteRequest request, byte[] payload, string? deviceId) {
        DateTime now = DateTime.UtcNow;
        long cursor = await vaults.NextCursor(vault.Id, payload.Length);

        Note note = new() {
            Id = request.Id,
            VaultId = vault.Id,
            Name = request.Name,
            HeadVersionId = request.InitialVersion.Id,
            Cursor = cursor,
            CreatedAt = now,
            UpdatedAt = now
        };
        await notes.CreateNote(note);

        // The first version is always a full document: there is no parent to diff against.
        request.InitialVersion.IsSnapshot = true;
        request.InitialVersion.ParentId = null;
        NoteVersion initial = BuildVersion(vault, note, request.InitialVersion, payload, cursor, deviceId, now);
        await versions.CreateVersion(initial);

        await sync.NotifyVaultChanged(
            vault.OwnerId, vault.Id, cursor, deviceId, [note], [SyncVersion.From(initial)]);
        return note;
    }

    public async Task<NoteVersion> AppendVersion(Vault vault, Note note, CreateVersionRequest request, byte[] payload,
        string? deviceId) {
        DateTime now = DateTime.UtcNow;
        long cursor = await vaults.NextCursor(vault.Id, payload.Length);

        NoteVersion version = BuildVersion(vault, note, request, payload, cursor, deviceId, now);
        await versions.CreateVersion(version);

        // Deliberately not rejecting a parent that isn't the current head. Two devices editing offline
        // legitimately produce siblings, and the DAG is what makes that representable - the client
        // merges them and appends a version with both parents.
        note.HeadVersionId = version.Id;
        note.Cursor = cursor;
        note.UpdatedAt = now;
        await notes.UpdateNote(note);

        await sync.NotifyVaultChanged(
            vault.OwnerId, vault.Id, cursor, deviceId, [note], [SyncVersion.From(version)]);
        return version;
    }

    public async Task RenameNote(Vault vault, Note note, string sealedName, string? deviceId) {
        long cursor = await vaults.NextCursor(vault.Id);

        note.Name = sealedName;
        note.Cursor = cursor;
        note.UpdatedAt = DateTime.UtcNow;
        await notes.UpdateNote(note);

        // A rename appends no version, so the note row is the whole of the change.
        await sync.NotifyVaultChanged(vault.OwnerId, vault.Id, cursor, deviceId, [note], []);
    }

    public async Task DeleteNote(Vault vault, Note note, string? deviceId) {
        long cursor = await vaults.NextCursor(vault.Id);

        // Tombstone rather than delete: the version history is the product, and offline clients need
        // something to sync against to learn the note is gone. Nothing is freed, so the vault's
        // storage total does not move - the note's history is all still there.
        DateTime now = DateTime.UtcNow;
        note.DeletedAt = now;
        note.Cursor = cursor;
        note.UpdatedAt = now;
        await notes.UpdateNote(note);

        await sync.NotifyVaultChanged(vault.OwnerId, vault.Id, cursor, deviceId, [note], []);
    }

    private static NoteVersion BuildVersion(Vault vault, Note note, CreateVersionRequest request, byte[] payload,
        long cursor, string? deviceId, DateTime now) {
        return new NoteVersion {
            Id = request.Id,
            NoteId = note.Id,
            VaultId = vault.Id,
            ParentId = request.ParentId,
            MergeParentId = request.MergeParentId,
            IsSnapshot = request.IsSnapshot,
            IsNamed = request.IsNamed,
            Payload = payload,
            Label = request.Label,
            DeviceId = deviceId,
            Size = payload.Length,
            Cursor = cursor,
            CreatedAt = now
        };
    }
}
