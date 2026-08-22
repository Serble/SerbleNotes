using System.Security.Claims;
using SerbleNotes.Backend.Database.Repos;
using SerbleNotes.Backend.Database.Schema;

namespace SerbleNotes.Backend.Services.Impl;

public class VaultAccess(IVaultRepo vaults, INoteRepo notes) : IVaultAccess {

    public async Task<Vault?> GetOwnedVault(ClaimsPrincipal principal, string vaultId) {
        string? userId = principal.FindFirstValue(ClaimTypes.NameIdentifier);
        if (userId == null) {
            return null;
        }

        Vault? vault = await vaults.GetVault(vaultId);
        if (vault == null || vault.Deleted || vault.OwnerId != userId) {
            return null;
        }

        return vault;
    }

    public async Task<OwnedNote?> GetOwnedNote(ClaimsPrincipal principal, string noteId) {
        Note? note = await notes.GetNote(noteId);
        if (note == null) {
            return null;
        }

        Vault? vault = await GetOwnedVault(principal, note.VaultId);
        if (vault == null) {
            return null;
        }

        return new OwnedNote(note, vault);
    }
}
