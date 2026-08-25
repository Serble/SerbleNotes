using SerbleNotes.Backend.Database.Schema;
using SerbleNotes.Backend.Schema;

namespace SerbleNotes.Backend.Database.Repos;

public interface IVersionRepo {
    /// <summary>
    /// A version by id, but only if it belongs to <paramref name="noteId"/>. Version ids are chosen
    /// by clients and unique across the whole table, so a lookup that does not say which note it
    /// means can answer with somebody else's row.
    /// </summary>
    Task<NoteVersion?> GetVersionInNote(string noteId, string id);

    /// <summary>
    /// Whether any version anywhere already has this id.
    /// </summary>
    /// <remarks>
    /// Asked so that a client-chosen id which collides with a row in someone else's vault is refused
    /// as a conflict rather than dying on the primary key as a 500. It answers yes or no and never
    /// hands back the row - which is the whole difference between this and the lookup above, and the
    /// reason the two are separate methods rather than one with a flag.
    /// </remarks>
    Task<bool> VersionExists(string id);
    /// <summary>Every version of a note, oldest first.</summary>
    Task<NoteVersion[]> GetVersionsForNote(string noteId);

    /// <summary>
    /// Just these versions of a note, for a client that already knows which ones it needs.
    /// </summary>
    /// <remarks>
    /// Scoped to the note like every other version lookup here, so a caller cannot name ids from
    /// somewhere else and have them returned. Ids that do not belong are simply absent from the
    /// result rather than an error - the client asked about a note it can read, and what it gets is
    /// what that note has.
    /// </remarks>
    Task<NoteVersion[]> GetVersionsByIds(string noteId, string[] ids);
    /// <summary>
    /// Versions past a cursor. With <paramref name="includePayloads"/> false the ciphertext column
    /// is never read, which is what keeps opening a vault cheap - see <see cref="SyncVersion"/>.
    /// </summary>
    Task<SyncVersion[]> GetChangedVersions(string vaultId, long sinceCursor, bool includePayloads);
    Task CreateVersion(NoteVersion version);
}
