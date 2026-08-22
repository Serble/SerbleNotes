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
    ///
    /// Null on notes written before names existed; those clients fall back to the first line.
    /// </summary>
    [StringLength(2048)]
    public string? Name { get; set; }

    /// <summary>
    /// Last version the server accepted. Clients treat this as a hint: with concurrent devices the
    /// DAG can have several leaves, and the client resolves the real head itself.
    /// </summary>
    [StringLength(36)]
    public string? HeadVersionId { get; set; }

    public long Cursor { get; set; }

    public DateTime CreatedAt { get; set; }

    public DateTime UpdatedAt { get; set; }

    public bool Deleted { get; set; }

    // Navigation properties
    [JsonIgnore]
    public Vault VaultNavigation { get; set; } = null!;
}
