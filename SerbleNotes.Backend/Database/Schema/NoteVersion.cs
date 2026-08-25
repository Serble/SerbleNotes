using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;
using System.Text.Json.Serialization;

namespace SerbleNotes.Backend.Database.Schema;

/// <summary>
/// One node in a note's version DAG. Parent pointers are plaintext so the server can serve history
/// ranges and garbage collect; the content is a ciphertext blob it can never open.
/// </summary>
public class NoteVersion {
    [Key, StringLength(36)]
    public string Id { get; set; } = null!;

    [StringLength(36), ForeignKey(nameof(NoteNavigation))]
    public string NoteId { get; set; } = null!;

    /// <summary>
    /// Denormalised from the note. Sync pulls "every version in this vault past cursor N", and
    /// carrying the vault here keeps that a single indexed scan instead of a join.
    /// </summary>
    [StringLength(36)]
    public string VaultId { get; set; } = null!;

    /// <summary>Null only for the first version of a note.</summary>
    [StringLength(36)]
    public string? ParentId { get; set; }

    /// <summary>Second parent, set when this version is a merge of two branches.</summary>
    [StringLength(36)]
    public string? MergeParentId { get; set; }

    /// <summary>
    /// True when the payload is a full encrypted document, false when it is an encrypted diff against
    /// the parent. Clients snapshot periodically so replaying history stays cheap.
    /// </summary>
    public bool IsSnapshot { get; set; }

    /// <summary>A manual restore point the user named, which is pinned and never pruned.</summary>
    public bool IsNamed { get; set; }

    /// <summary>
    /// The ciphertext itself. Big payloads move to S3 in a later iteration; MVP keeps them inline.
    ///
    /// Bytes rather than the base64 text this used to be. The wire is still base64 - JSON has no
    /// other way to carry bytes, and System.Text.Json renders a byte[] as exactly that string - but
    /// storing the encoded form cost a third more disk than the ciphertext it held, on far and away
    /// the largest table here, and utf8mb4 made MySQL reserve four bytes per character of it
    /// whenever a query needed a temporary table. Changing this after release would have meant
    /// rebuilding that table.
    /// </summary>
    [Column(TypeName = "longblob")]
    public byte[] Payload { get; set; } = null!;

    /// <summary>Encrypted label for a named restore point. The name is user text, so the server can't see it.</summary>
    [StringLength(512)]
    public string? Label { get; set; }

    /// <summary>Which device produced this version, so its own sync events can be ignored locally.</summary>
    [StringLength(64)]
    public string? DeviceId { get; set; }

    /// <summary>Length of <see cref="Payload"/> in bytes - the real cost of storing it.</summary>
    public int Size { get; set; }

    public long Cursor { get; set; }

    public DateTime CreatedAt { get; set; }

    // Navigation properties
    [JsonIgnore]
    public Note NoteNavigation { get; set; } = null!;
}
