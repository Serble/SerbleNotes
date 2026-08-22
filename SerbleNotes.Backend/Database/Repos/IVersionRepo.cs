using SerbleNotes.Backend.Database.Schema;

namespace SerbleNotes.Backend.Database.Repos;

public interface IVersionRepo {
    Task<NoteVersion?> GetVersion(string id);
    Task<NoteVersion[]> GetVersionsForNote(string noteId);
    Task<NoteVersion[]> GetChangedVersions(string vaultId, long sinceCursor);
    Task CreateVersion(NoteVersion version);
}
