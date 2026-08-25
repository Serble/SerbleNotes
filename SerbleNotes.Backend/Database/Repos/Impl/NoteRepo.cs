using Microsoft.EntityFrameworkCore;
using SerbleNotes.Backend.Database.Schema;

namespace SerbleNotes.Backend.Database.Repos.Impl;

public class NoteRepo(NotesDatabaseContext context) : INoteRepo {

    public Task<Note?> GetNote(string id) {
        return context.Notes.FindAsync(id).AsTask();
    }

    public async Task<Note[]> GetNotesInVault(string vaultId) {
        return await context.Notes
            .Where(n => n.VaultId == vaultId && n.DeletedAt == null)
            .OrderBy(n => n.CreatedAt)
            .ToArrayAsync();
    }

    public async Task<Note[]> GetChangedNotes(string vaultId, long sinceCursor) {
        // Tombstones are included on purpose: a client that was offline when a note was deleted only
        // learns about it from the deleted row.
        return await context.Notes
            .Where(n => n.VaultId == vaultId && n.Cursor > sinceCursor)
            .OrderBy(n => n.Cursor)
            .ToArrayAsync();
    }

    public Task<int> CountNotesInVault(string vaultId) {
        // Tombstones count. They are rows the service stores, and their history is still there.
        return context.Notes.CountAsync(n => n.VaultId == vaultId);
    }

    public Task CreateNote(Note note) {
        context.Notes.Add(note);
        return context.SaveChangesAsync();
    }

    public Task UpdateNote(Note note) {
        context.Notes.Update(note);
        return context.SaveChangesAsync();
    }
}
