using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;
using System.Text.Json.Serialization;

namespace SerbleNotes.Backend.Database.Schema;

/// <summary>
/// Note identity, its encrypted name, and sync bookkeeping. Nothing readable: the body lives in the
/// version payloads and the name is sealed with the same vault key, so the server can order and
/// deliver notes without ever knowing what any of them are called or contain.
/// </summary>
public class Note {
    [Key, StringLength(36)]
    public string Id { get; set; } = null!;

    [StringLength(36), ForeignKey(nameof(VaultNavigation))]
    public string VaultId { get; set; } = null!;

    /// <summary>
    /// The note's name and folder path, encrypted. A name is content: "Medical/Test results" tells
    /// you as much as the note body does, so the server gets it as ciphertext like everything else.
    /// Folders exist only as separators inside this string - there are no folder rows to leak.
    /// </summary>
    [StringLength(2048)]
    public string Name { get; set; } = null!;

    /// <summary>
    /// Last version the server accepted. Clients treat this as a hint: with concurrent devices the
    /// DAG can have several leaves, and the client resolves the real head itself.
    /// </summary>
    [StringLength(36)]
    public string? HeadVersionId { get; set; }

    public long Cursor { get; set; }

    public DateTime CreatedAt { get; set; }

    public DateTime UpdatedAt { get; set; }

    /// <summary>
    /// When the note was tombstoned, or null while it is live. See <see cref="Vault.DeletedAt"/> for
    /// why this is a time rather than a flag.
    /// </summary>
    public DateTime? DeletedAt { get; set; }

    /// <summary>The wire has always carried a flag, and clients only ever ask the yes/no question.</summary>
    [NotMapped]
    public bool Deleted => DeletedAt != null;

    // Navigation properties
    [JsonIgnore]
    public Vault VaultNavigation { get; set; } = null!;
}
