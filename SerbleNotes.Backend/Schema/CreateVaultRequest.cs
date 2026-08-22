using System.ComponentModel.DataAnnotations;

namespace SerbleNotes.Backend.Schema;

public class CreateVaultRequest {
    [Required, StringLength(128, MinimumLength = 1)]
    public string Name { get; set; } = null!;

    public bool Encrypted { get; set; }

    /// <summary>
    /// The sealed vault key for an encrypted vault, or the bare vault key for an unencrypted one. The
    /// client does the wrapping; the server only files it away.
    /// </summary>
    [Required, StringLength(512)]
    public string WrappedKey { get; set; } = null!;

    [StringLength(64)]
    public string? KdfSalt { get; set; }

    [StringLength(256)]
    public string? KdfParams { get; set; }
}
