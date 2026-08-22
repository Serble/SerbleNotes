using System.ComponentModel.DataAnnotations;

namespace SerbleNotes.Backend.Schema;

public class CreateVersionRequest {
    [Required, StringLength(36, MinimumLength = 36)]
    public string Id { get; set; } = null!;

    [StringLength(36)]
    public string? ParentId { get; set; }

    [StringLength(36)]
    public string? MergeParentId { get; set; }

    public bool IsSnapshot { get; set; }

    public bool IsNamed { get; set; }

    /// <summary>Base64 ciphertext: a full document when IsSnapshot, otherwise a diff against the parent.</summary>
    [Required]
    public string Payload { get; set; } = null!;

    /// <summary>Encrypted label for a named restore point.</summary>
    [StringLength(512)]
    public string? Label { get; set; }
}
