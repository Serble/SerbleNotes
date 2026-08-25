using System.Security.Claims;
using SerbleNotes.Backend.Database.Schema;

namespace SerbleNotes.Backend.Services;

/// <summary>
/// Every vault, note and version lookup goes through here so the access check can't be forgotten
/// in one controller and remembered in another. Returns null for "not found" and for "not yours"
/// alike - callers turn both into a 404 so the API doesn't confirm that someone else's id exists.
/// </summary>
public interface IVaultAccess {
    Task<VaultAccess?> GetVault(ClaimsPrincipal principal, string vaultId);
    Task<NoteAccess?> GetNote(ClaimsPrincipal principal, string noteId);
}

/// <summary>
/// A vault the caller may open, and the key row that says so.
/// </summary>
/// <param name="Key">
/// The caller's own wrapped key. Carried alongside the vault because every response that describes
/// a vault has to include it, and it is per person rather than per vault.
/// </param>
/// <param name="IsOwner">
/// Whether the caller owns the vault, as against merely holding a key to it. The two are the same
/// thing today; they are asked separately because deleting a vault and changing its password are
/// the owner's to do, and those checks should already be written when they stop being equivalent.
/// </param>
public record VaultAccess(Vault Vault, VaultKey Key, bool IsOwner);

public record NoteAccess(Note Note, VaultAccess Access) {
    public Vault Vault => Access.Vault;
}
