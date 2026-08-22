using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;
using System.Text.Json.Serialization;

namespace SerbleNotes.Backend.Database.Schema;

/// <summary>
/// A vault owns a set of notes and exactly one content key. The server never holds the unwrapped key
/// for an encrypted vault, so everything it stores here is either public metadata or a blob it cannot
/// open.
/// </summary>
public class Vault {
    [Key, StringLength(36)]
    public string Id { get; set; } = null!;

    /// <summary>
    /// Deliberately plaintext: the vault list has to render before the user has unlocked anything.
    /// This is a known metadata leak - note titles and bodies live inside the ciphertext instead.
    /// </summary>
    [StringLength(128)]
    public string Name { get; set; } = null!;

    [StringLength(64), ForeignKey(nameof(OwnerNavigation))]
    public string OwnerId { get; set; } = null!;

    /// <summary>
    /// False means the vault key below is stored in the clear and the server can read every note in
    /// this vault. That is the entire point of the option; never present such a vault as private.
    /// </summary>
    public bool Encrypted { get; set; }

    /// <summary>
    /// Encrypted vaults: the vault key sealed with an Argon2id key derived from the vault password.
    /// Unencrypted vaults: the vault key itself. Base64 either way, opaque to the server either way.
    /// </summary>
    [StringLength(512)]
    public string WrappedKey { get; set; } = null!;

    /// <summary>Base64 Argon2id salt. Null for unencrypted vaults.</summary>
    [StringLength(64)]
    public string? KdfSalt { get; set; }

    /// <summary>JSON blob of Argon2id parameters, stored so params can change without breaking old vaults.</summary>
    [StringLength(256)]
    public string? KdfParams { get; set; }

    /// <summary>Monotonic per-vault change counter. Every write bumps it; clients sync from a cursor.</summary>
    public long Cursor { get; set; }

    public DateTime CreatedAt { get; set; }

    public DateTime UpdatedAt { get; set; }

    public bool Deleted { get; set; }

    // Navigation properties
    [JsonIgnore]
    public NotesUser OwnerNavigation { get; set; } = null!;
}
