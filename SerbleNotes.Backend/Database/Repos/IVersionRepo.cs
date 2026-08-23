using SerbleNotes.Backend.Database.Schema;
using SerbleNotes.Backend.Schema;

namespace SerbleNotes.Backend.Database.Repos;

public interface IVersionRepo {
    Task<NoteVersion?> GetVersion(string id);
    Task<NoteVersion[]> GetVersionsForNote(string noteId);
    /// <summary>
    /// Versions past a cursor. With <paramref name="includePayloads"/> false the ciphertext column
    /// is never read, which is what keeps opening a vault cheap - see <see cref="SyncVersion"/>.
    /// </summary>
    Task<SyncVersion[]> GetChangedVersions(string vaultId, long sinceCursor, bool includePayloads);
    Task CreateVersion(NoteVersion version);
}
