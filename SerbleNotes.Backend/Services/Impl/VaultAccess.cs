using System.Security.Claims;
using SerbleNotes.Backend.Database.Repos;
using SerbleNotes.Backend.Database.Schema;

namespace SerbleNotes.Backend.Services.Impl;

public class VaultAccessService(IVaultRepo vaults, INoteRepo notes) : IVaultAccess {

    public async Task<VaultAccess?> GetVault(ClaimsPrincipal principal, string vaultId) {
        string? userId = principal.FindFirstValue(ClaimTypes.NameIdentifier);
        if (userId == null) {
            return null;
        }

        Vault? vault = await vaults.GetVault(vaultId);
        if (vault == null || vault.DeletedAt != null) {
            return null;
        }

        // Access is holding a key, not being the owner. Today only the owner ever holds one, so this
        // is the same test it has always been - but it is the test that stays correct when a vault
        // can be shared, and the owner check below is then the one that has to be asked separately.
        VaultKey? key = await vaults.GetKey(vaultId, userId);
        if (key == null) {
            return null;
        }

        return new VaultAccess(vault, key, vault.OwnerId == userId);
    }

    public async Task<NoteAccess?> GetNote(ClaimsPrincipal principal, string noteId) {
        Note? note = await notes.GetNote(noteId);
        if (note == null) {
            return null;
        }

        VaultAccess? access = await GetVault(principal, note.VaultId);
        if (access == null) {
            return null;
        }

        return new NoteAccess(note, access);
    }
}
