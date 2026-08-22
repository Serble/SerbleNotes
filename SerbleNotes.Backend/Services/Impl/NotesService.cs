using SerbleNotes.Backend.Database.Repos;
using SerbleNotes.Backend.Database.Schema;
using SerbleNotes.Backend.Schema;

namespace SerbleNotes.Backend.Services.Impl;

public class NotesService(
    IVaultRepo vaults,
    INoteRepo notes,
    IVersionRepo versions,
    ISyncNotifier sync) : INotesService {

    public async Task<Note> CreateNote(Vault vault, CreateNoteRequest request, string? deviceId) {
        DateTime now = DateTime.UtcNow;
        long cursor = await vaults.NextCursor(vault.Id);

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
        await versions.CreateVersion(BuildVersion(vault, note, request.InitialVersion, cursor, deviceId, now));

        await sync.NotifyVaultChanged(vault.OwnerId, vault.Id, cursor, deviceId);
        return note;
    }

    public async Task<NoteVersion> AppendVersion(Vault vault, Note note, CreateVersionRequest request, string? deviceId) {
        DateTime now = DateTime.UtcNow;
        long cursor = await vaults.NextCursor(vault.Id);

        NoteVersion version = BuildVersion(vault, note, request, cursor, deviceId, now);
        await versions.CreateVersion(version);

        // Deliberately not rejecting a parent that isn't the current head. Two devices editing offline
        // legitimately produce siblings, and the DAG is what makes that representable - the client
        // merges them and appends a version with both parents.
        note.HeadVersionId = version.Id;
        note.Cursor = cursor;
        note.UpdatedAt = now;
        await notes.UpdateNote(note);

        await sync.NotifyVaultChanged(vault.OwnerId, vault.Id, cursor, deviceId);
        return version;
    }

    public async Task RenameNote(Vault vault, Note note, string sealedName, string? deviceId) {
        long cursor = await vaults.NextCursor(vault.Id);

        note.Name = sealedName;
        note.Cursor = cursor;
        note.UpdatedAt = DateTime.UtcNow;
        await notes.UpdateNote(note);

        await sync.NotifyVaultChanged(vault.OwnerId, vault.Id, cursor, deviceId);
    }

    public async Task DeleteNote(Vault vault, Note note, string? deviceId) {
        long cursor = await vaults.NextCursor(vault.Id);

        // Tombstone rather than delete: the version history is the product, and offline clients need
        // something to sync against to learn the note is gone.
        note.Deleted = true;
        note.Cursor = cursor;
        note.UpdatedAt = DateTime.UtcNow;
        await notes.UpdateNote(note);

        await sync.NotifyVaultChanged(vault.OwnerId, vault.Id, cursor, deviceId);
    }

    private static NoteVersion BuildVersion(Vault vault, Note note, CreateVersionRequest request, long cursor,
        string? deviceId, DateTime now) {
        return new NoteVersion {
            Id = request.Id,
            NoteId = note.Id,
            VaultId = vault.Id,
            ParentId = request.ParentId,
            MergeParentId = request.MergeParentId,
            IsSnapshot = request.IsSnapshot,
            IsNamed = request.IsNamed,
            Payload = request.Payload,
            Label = request.Label,
            DeviceId = deviceId,
            Size = request.Payload.Length,
            Cursor = cursor,
            CreatedAt = now
        };
    }
}
