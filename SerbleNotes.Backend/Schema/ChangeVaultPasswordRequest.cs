using System.ComponentModel.DataAnnotations;

namespace SerbleNotes.Backend.Schema;

/// <summary>
/// New key material for a vault whose password has changed. The vault key inside the blob is the
/// same one as before - only the wrapping around it is new - so nothing else in the vault changes
/// and no note is rewritten.
///
/// The server cannot check the old password, because it cannot open either blob. The client proves
/// it knew the old one by being able to produce this at all.
/// </summary>
public class ChangeVaultPasswordRequest {
    /// <summary>The vault key sealed under the new password. Opaque here, as ever.</summary>
    [Required, StringLength(512)]
    public string WrappedKey { get; set; } = null!;

    [Required, StringLength(64)]
    public string KdfSalt { get; set; } = null!;

    /// <summary>Argon2id parameters for the new wrapping; a change is a chance to raise them.</summary>
    [Required, StringLength(256)]
    public string KdfParams { get; set; } = null!;
}
