using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using SerbleNotes.Backend.Database.Schema;

namespace SerbleNotes.Backend.Database.Repos.Impl;

public class VaultRepo(NotesDatabaseContext context) : IVaultRepo {

    public Task<Vault?> GetVault(string id) {
        return context.Vaults.FindAsync(id).AsTask();
    }

    public async Task<Vault[]> GetVaultsForUser(string userId) {
        return await context.Vaults
            .Where(v => v.OwnerId == userId && !v.Deleted)
            .OrderBy(v => v.CreatedAt)
            .ToArrayAsync();
    }

    public Task<int> CountVaultsForUser(string userId) {
        return context.Vaults.CountAsync(v => v.OwnerId == userId && !v.Deleted);
    }

    public Task CreateVault(Vault vault) {
        context.Vaults.Add(vault);
        return context.SaveChangesAsync();
    }

    public Task UpdateVault(Vault vault) {
        context.Vaults.Update(vault);
        return context.SaveChangesAsync();
    }

    public async Task<long> NextCursor(string vaultId) {
        // The increment and the read have to be one atomic step or two devices writing at once can
        // be handed the same cursor and one of them becomes invisible to sync. The UPDATE takes a row
        // lock that the SELECT in the same transaction rides on.
        await using IDbContextTransaction transaction = await context.Database.BeginTransactionAsync();

        await context.Database.ExecuteSqlInterpolatedAsync(
            $"UPDATE `Vaults` SET `Cursor` = `Cursor` + 1, `UpdatedAt` = UTC_TIMESTAMP(6) WHERE `Id` = {vaultId}");

        long cursor = await context.Vaults
            .AsNoTracking()
            .Where(v => v.Id == vaultId)
            .Select(v => v.Cursor)
            .FirstAsync();

        await transaction.CommitAsync();
        return cursor;
    }
}
