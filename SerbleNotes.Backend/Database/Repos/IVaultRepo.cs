using SerbleNotes.Backend.Database.Schema;

namespace SerbleNotes.Backend.Database.Repos;

public interface IVaultRepo {
    Task<Vault?> GetVault(string id);
    Task<Vault[]> GetVaultsForUser(string userId);
    Task<int> CountVaultsForUser(string userId);
    Task CreateVault(Vault vault);
    Task UpdateVault(Vault vault);

    /// <summary>
    /// Reserves the next change cursor for a vault. Every write that clients need to see goes through
    /// here so a single counter orders the whole vault.
    /// </summary>
    Task<long> NextCursor(string vaultId);
}
