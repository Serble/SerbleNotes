using SerbleNotes.Backend.Database.Schema;
using SerbleNotes.Backend.Services;

namespace SerbleNotes.Backend.Schema;

/// <summary>
/// A vault as one person sees it: the vault's own metadata, plus that person's copy of its key.
/// </summary>
/// <remarks>
/// The key material moved to <see cref="VaultKey"/> so that a vault can one day have more than one
/// holder. This shape exists so that move stayed on the server: it is exactly the JSON the vault row
/// used to serialise to, so no client had to learn that the key now lives somewhere else. What a
/// client wants has not changed - it is "the vault, and my key to it" either way.
/// </remarks>
public class VaultResponse {
    public string Id { get; set; } = null!;
    public string Name { get; set; } = null!;
    public string OwnerId { get; set; } = null!;
    public bool Encrypted { get; set; }

    /// <summary>The caller's own wrapped key, never anybody else's.</summary>
    public string WrappedKey { get; set; } = null!;

    public string? KdfSalt { get; set; }
    public string? KdfParams { get; set; }
    public long Cursor { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
    public bool Deleted { get; set; }

    public static VaultResponse From(Vault vault, VaultKey key) {
        return new VaultResponse {
            Id = vault.Id,
            Name = vault.Name,
            OwnerId = vault.OwnerId,
            Encrypted = vault.Encrypted,
            WrappedKey = key.WrappedKey,
            KdfSalt = key.KdfSalt,
            KdfParams = key.KdfParams,
            Cursor = vault.Cursor,
            CreatedAt = vault.CreatedAt,
            UpdatedAt = vault.UpdatedAt,
            Deleted = vault.Deleted
        };
    }

    public static VaultResponse From(VaultAccess access) => From(access.Vault, access.Key);
}
