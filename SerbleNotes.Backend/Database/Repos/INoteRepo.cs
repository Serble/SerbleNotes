using SerbleNotes.Backend.Database.Schema;

namespace SerbleNotes.Backend.Database.Repos;

public interface INoteRepo {
    Task<Note?> GetNote(string id);
    Task<Note[]> GetNotesInVault(string vaultId);
    Task<Note[]> GetChangedNotes(string vaultId, long sinceCursor);
    Task CreateNote(Note note);
    Task UpdateNote(Note note);
}
