using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;
using System.Text.Json.Serialization;

namespace SerbleNotes.Backend.Database.Schema;

/// <summary>
/// A vault owns a set of notes and exactly one content key. The server never holds the unwrapped key
/// for an encrypted vault, so everything it stores here is either public metadata or a blob it cannot
/// open.
/// </summary>
/// <remarks>
/// The key material itself is deliberately *not* here - it lives in <see cref="VaultKey"/>, one row
/// per person who can open the vault. Today that is always exactly one row, for the owner. See that
/// class for why the indirection exists before there is anything using it.
/// </remarks>
public class Vault {
    [Key, StringLength(36)]
    public string Id { get; set; } = null!;

    /// <summary>
    /// Deliberately plaintext: the vault list has to render before the user has unlocked anything.
    /// This is a known metadata leak - note titles and bodies live inside the ciphertext instead.
    /// </summary>
    [StringLength(128)]
    public string Name { get; set; } = null!;

    /// <summary>
    /// Who the vault belongs to. Distinct from who can open it: quota, deletion and password changes
    /// are the owner's, while reading is anyone holding a <see cref="VaultKey"/> for it.
    /// </summary>
    [StringLength(64), ForeignKey(nameof(OwnerNavigation))]
    public string OwnerId { get; set; } = null!;

    /// <summary>
    /// False means the vault key is stored in the clear and the server can read every note in this
    /// vault. That is the entire point of the option; never present such a vault as private.
    /// </summary>
    public bool Encrypted { get; set; }

    /// <summary>Monotonic per-vault change counter. Every write bumps it; clients sync from a cursor.</summary>
    public long Cursor { get; set; }

    /// <summary>
    /// Ciphertext bytes stored across every version in this vault, kept as a running total rather
    /// than summed on demand. A user's quota is the sum of this over the vaults they own, which is
    /// at most a hundred indexed rows - where summing <c>NoteVersions.Size</c> would scan every
    /// version they have ever written, on the path of every single save.
    ///
    /// It only ever grows, because nothing is ever hard-deleted: a tombstoned note keeps its history.
    /// A purge of old tombstones will have to bring it back down.
    /// </summary>
    public long StorageBytes { get; set; }

    public DateTime CreatedAt { get; set; }

    public DateTime UpdatedAt { get; set; }

    /// <summary>
    /// When the vault was tombstoned, or null while it is live.
    ///
    /// A timestamp rather than a flag because a retention window is the only way this data ever
    /// actually goes away, and "delete tombstones older than N days" is a question a bool cannot
    /// answer. Nothing reads it yet; it is here now because it cannot be reconstructed later.
    /// </summary>
    public DateTime? DeletedAt { get; set; }

    /// <summary>The wire has always carried a flag, and clients only ever ask the yes/no question.</summary>
    [NotMapped]
    public bool Deleted => DeletedAt != null;

    // Navigation properties
    [JsonIgnore]
    public NotesUser OwnerNavigation { get; set; } = null!;
}
