using SerbleNotes.Backend.Database.Schema;

namespace SerbleNotes.Backend.Database.Repos;

public interface IVaultRepo {
    Task<Vault?> GetVault(string id);

    /// <summary>
    /// Vaults this user holds a key to - today, the ones they own - each with the key that grants it,
    /// since every response describing a vault has to carry the caller's own key alongside it.
    /// </summary>
    Task<VaultKey[]> GetVaultsForUser(string userId);

    /// <summary>Live vaults this user owns. Ownership, not access - the quota is the owner's.</summary>
    Task<int> CountVaultsForUser(string userId);

    /// <summary>Ciphertext stored across every live vault this user owns.</summary>
    Task<long> TotalStorageForUser(string userId);

    Task CreateVault(Vault vault);

    /// <summary>
    /// Tombstones a vault, touching only the two columns that change.
    /// </summary>
    /// <remarks>
    /// Not a read-modify-write of the whole entity: <see cref="Vault.StorageBytes"/> and
    /// <see cref="Vault.Cursor"/> are counters that another device's save can move between this
    /// request loading the row and writing it back, and writing the row wholesale would quietly put
    /// them back to what they were.
    /// </remarks>
    Task MarkVaultDeleted(string vaultId, DateTime when);

    /// <summary>This user's key to this vault, or null if they have no access to it.</summary>
    Task<VaultKey?> GetKey(string vaultId, string userId);

    Task CreateKey(VaultKey key);
    Task UpdateKey(VaultKey key);

    /// <summary>
    /// Reserves the next change cursor for a vault, and adds <paramref name="storageDelta"/> bytes to
    /// its running total. Every write that clients need to see goes through here so a single counter
    /// orders the whole vault.
    /// </summary>
    /// <remarks>
    /// The storage total rides along rather than being its own update because it changes on exactly
    /// the writes that take a cursor, and one statement cannot leave the two disagreeing.
    /// </remarks>
    Task<long> NextCursor(string vaultId, long storageDelta = 0);
}
