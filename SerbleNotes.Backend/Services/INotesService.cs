using SerbleNotes.Backend.Database.Schema;
using SerbleNotes.Backend.Schema;

namespace SerbleNotes.Backend.Services;

/// <summary>
/// Owns the write choreography every mutation shares: reserve a cursor, persist, tell the other
/// devices. Controllers call this instead of touching repos directly so a write can't ship without a
/// cursor and end up invisible to sync.
/// </summary>
public interface INotesService {
    Task<Note> CreateNote(Vault vault, CreateNoteRequest request, string? deviceId);

    /// <summary>
    /// Changes a note's sealed name. Deliberately not a new version: a rename is a metadata change,
    /// the same way it is on a filesystem, so history stays a record of what the note said rather
    /// than where it was filed.
    /// </summary>
    Task RenameNote(Vault vault, Note note, string sealedName, string? deviceId);
    Task<NoteVersion> AppendVersion(Vault vault, Note note, CreateVersionRequest request, string? deviceId);
    Task DeleteNote(Vault vault, Note note, string? deviceId);
}
