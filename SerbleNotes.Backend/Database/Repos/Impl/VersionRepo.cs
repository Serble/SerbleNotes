using Microsoft.EntityFrameworkCore;
using SerbleNotes.Backend.Database.Schema;
using SerbleNotes.Backend.Schema;

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

    public async Task<SyncVersion[]> GetChangedVersions(string vaultId, long sinceCursor, bool includePayloads) {
        IQueryable<NoteVersion> changed = context.NoteVersions
            .AsNoTracking()
            .Where(v => v.VaultId == vaultId && v.Cursor > sinceCursor)
            .OrderBy(v => v.Cursor);

        if (includePayloads) {
            // This path reads every column anyway, so the mapping happens in memory rather than as
            // a second projection that would have to be kept in step with the one below.
            NoteVersion[] rows = await changed.ToArrayAsync();
            return rows.Select(SyncVersion.From).ToArray();
        }

        // Written out rather than sharing SyncVersion.From because this one has to be translated to SQL:
        // a method call would be evaluated on the client, which means materialising the entity and
        // reading the longtext column that this whole path exists to avoid. `Payload = null` is a
        // constant, so it never appears in the SELECT list.
        return await changed
            .Select(v => new SyncVersion {
                Id = v.Id,
                NoteId = v.NoteId,
                VaultId = v.VaultId,
                ParentId = v.ParentId,
                MergeParentId = v.MergeParentId,
                IsSnapshot = v.IsSnapshot,
                IsNamed = v.IsNamed,
                Payload = null,
                Label = v.Label,
                DeviceId = v.DeviceId,
                Size = v.Size,
                Cursor = v.Cursor,
                CreatedAt = v.CreatedAt
            })
            .ToArrayAsync();
    }

    public Task CreateVersion(NoteVersion version) {
        context.NoteVersions.Add(version);
        return context.SaveChangesAsync();
    }
}
