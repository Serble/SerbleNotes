using System.Security.Claims;
using SerbleNotes.Backend.Database.Schema;

namespace SerbleNotes.Backend.Services;

/// <summary>
/// Every vault, note and version lookup goes through here so the ownership check can't be forgotten
/// in one controller and remembered in another. Returns null for "not found" and for "not yours"
/// alike - callers turn both into a 404 so the API doesn't confirm that someone else's id exists.
/// </summary>
public interface IVaultAccess {
    Task<Vault?> GetOwnedVault(ClaimsPrincipal principal, string vaultId);
    Task<OwnedNote?> GetOwnedNote(ClaimsPrincipal principal, string noteId);
}

public record OwnedNote(Note Note, Vault Vault);
