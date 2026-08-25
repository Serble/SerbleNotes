using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;
using System.Text.Json.Serialization;

namespace SerbleNotes.Backend.Database.Schema;

/// <summary>
/// One person's copy of one vault's key, and with it their access to that vault.
/// </summary>
/// <remarks>
/// Today there is exactly one of these per vault, for the owner, and nothing in the app can make a
/// second. It exists as its own table anyway because of what the alternative costs.
///
/// The vault key is a single random key shared by everyone who can read the vault; what differs per
/// person is the wrapping around it. Putting <see cref="WrappedKey"/> on the vault row therefore
/// says "one vault, one wrapping, one reader" in the schema itself, and sharing a vault later would
/// mean moving key material off a table with live rows in it and rewriting every query that reads
/// it. Here, sharing is inserting rows: seal the same vault key under the new member's key material
/// and add one. Nothing about the notes, the versions or the sync path changes at all, because none
/// of them ever knew who could read them.
///
/// Membership *is* this row, rather than a separate members table beside it. Without a key there is
/// nothing to see - the server holds only ciphertext - so a membership record with no key would be
/// a second structure that could disagree with the first about who can read a vault. The composite
/// key is declared in <c>NotesDatabaseContext</c>, where the rest of the model shape lives. There is no
/// role column yet: with one row per vault there is nothing for it to distinguish, and it is a
/// nullable column away whenever there is.
/// </remarks>
public class VaultKey {
    [StringLength(36), ForeignKey(nameof(VaultNavigation))]
    public string VaultId { get; set; } = null!;

    [StringLength(64), ForeignKey(nameof(UserNavigation))]
    public string UserId { get; set; } = null!;

    /// <summary>
    /// The vault key sealed with an Argon2id key derived from this person's vault password - or, for
    /// an unencrypted vault, the vault key itself in the clear. Base64 either way, opaque here either
    /// way.
    /// </summary>
    [StringLength(512)]
    public string WrappedKey { get; set; } = null!;

    /// <summary>Base64 Argon2id salt. Null for unencrypted vaults.</summary>
    [StringLength(64)]
    public string? KdfSalt { get; set; }

    /// <summary>JSON blob of Argon2id parameters, stored so params can change without breaking old vaults.</summary>
    [StringLength(256)]
    public string? KdfParams { get; set; }

    public DateTime CreatedAt { get; set; }

    // Navigation properties
    [JsonIgnore]
    public Vault VaultNavigation { get; set; } = null!;

    [JsonIgnore]
    public NotesUser UserNavigation { get; set; } = null!;
}
