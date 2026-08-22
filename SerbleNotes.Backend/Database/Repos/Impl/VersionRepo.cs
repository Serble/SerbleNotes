using Microsoft.EntityFrameworkCore;
using SerbleNotes.Backend.Database.Schema;

namespace SerbleNotes.Backend.Database.Repos.Impl;

public class VersionRepo(NotesDatabaseContext context) : IVersionRepo {

    public Task<NoteVersion?> GetVersion(string id) {
        return context.NoteVersions.FindAsync(id).AsTask();
    }

    public async Task<NoteVersion[]> GetVersionsForNote(string noteId) {
        return await context.NoteVersions
            .Where(v => v.NoteId == noteId)
            .OrderBy(v => v.Cursor)
            .ToArrayAsync();
    }

    public async Task<NoteVersion[]> GetChangedVersions(string vaultId, long sinceCursor) {
        return await context.NoteVersions
            .Where(v => v.VaultId == vaultId && v.Cursor > sinceCursor)
            .OrderBy(v => v.Cursor)
            .ToArrayAsync();
    }

    public Task CreateVersion(NoteVersion version) {
        context.NoteVersions.Add(version);
        return context.SaveChangesAsync();
    }
}
