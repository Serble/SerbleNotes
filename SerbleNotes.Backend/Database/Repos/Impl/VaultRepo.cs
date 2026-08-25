using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using SerbleNotes.Backend.Database.Schema;

namespace SerbleNotes.Backend.Database.Repos.Impl;

public class VaultRepo(NotesDatabaseContext context) : IVaultRepo {

    public Task<Vault?> GetVault(string id) {
        return context.Vaults.FindAsync(id).AsTask();
    }

    public async Task<VaultKey[]> GetVaultsForUser(string userId) {
        // Through the key rows rather than through OwnerId: holding a key is what access means, and
        // today the owner's key is the only one there is. A shared vault appears here by existing.
        return await context.VaultKeys
            .Include(k => k.VaultNavigation)
            .Where(k => k.UserId == userId && k.VaultNavigation.DeletedAt == null)
            .OrderBy(k => k.VaultNavigation.CreatedAt)
            .ToArrayAsync();
    }

    public Task<int> CountVaultsForUser(string userId) {
        return context.Vaults.CountAsync(v => v.OwnerId == userId && v.DeletedAt == null);
    }

    public async Task<long> TotalStorageForUser(string userId) {
        // SumAsync over an empty set throws on a non-nullable selector, and an account with no
        // vaults is the ordinary first-run case rather than an error.
        return await context.Vaults
            .Where(v => v.OwnerId == userId && v.DeletedAt == null)
            .SumAsync(v => (long?)v.StorageBytes) ?? 0;
    }

    public Task CreateVault(Vault vault) {
        context.Vaults.Add(vault);
        return context.SaveChangesAsync();
    }

    public Task MarkVaultDeleted(string vaultId, DateTime when) {
        return context.Vaults
            .Where(v => v.Id == vaultId)
            .ExecuteUpdateAsync(set => set
                .SetProperty(v => v.DeletedAt, when)
                .SetProperty(v => v.UpdatedAt, when));
    }

    public Task<VaultKey?> GetKey(string vaultId, string userId) {
        return context.VaultKeys.FindAsync(vaultId, userId).AsTask();
    }

    public Task CreateKey(VaultKey key) {
        context.VaultKeys.Add(key);
        return context.SaveChangesAsync();
    }

    public Task UpdateKey(VaultKey key) {
        context.VaultKeys.Update(key);
        return context.SaveChangesAsync();
    }

    public async Task<long> NextCursor(string vaultId, long storageDelta = 0) {
        // The increment and the read have to be one atomic step or two devices writing at once can
        // be handed the same cursor and one of them becomes invisible to sync. The UPDATE takes a row
        // lock that the SELECT in the same transaction rides on.
        await using IDbContextTransaction transaction = await context.Database.BeginTransactionAsync();

        await context.Database.ExecuteSqlInterpolatedAsync(
            $"""
             UPDATE `Vaults`
             SET `Cursor` = `Cursor` + 1,
                 `StorageBytes` = `StorageBytes` + {storageDelta},
                 `UpdatedAt` = UTC_TIMESTAMP(6)
             WHERE `Id` = {vaultId}
             """);

        long cursor = await context.Vaults
            .AsNoTracking()
            .Where(v => v.Id == vaultId)
            .Select(v => v.Cursor)
            .FirstAsync();

        await transaction.CommitAsync();
        return cursor;
    }
}
