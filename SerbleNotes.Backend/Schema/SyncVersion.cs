namespace SerbleNotes.Backend.Schema;

/// <summary>
/// A version as sync sees it: every pointer the client needs to walk the DAG, and the payload only
/// when it asked for one.
/// </summary>
/// <remarks>
/// Opening a vault needs the shape of its history, not its contents - the tree is drawn from note
/// names and only the note actually being read has to be decrypted. Sending every payload made
/// that first call carry the whole vault: 6.5 MB for a 196-note vault here, 92% of it five large
/// notes nobody had opened. With <see cref="Payload"/> left out the same call is about 85 KB, and
/// the bodies come from GET /api/notes/{id}/versions when a note is opened.
///
/// <see cref="Size"/> is the payload's length in the database, so a client can still report how
/// much a history takes up without holding any of it.
/// </remarks>
public class SyncVersion {
    public string Id { get; set; } = null!;
    public string NoteId { get; set; } = null!;
    public string VaultId { get; set; } = null!;
    public string? ParentId { get; set; }
    public string? MergeParentId { get; set; }
    public bool IsSnapshot { get; set; }
    public bool IsNamed { get; set; }

    /// <summary>Base64 ciphertext, or null when this response carries metadata only.</summary>
    public string? Payload { get; set; }

    public string? Label { get; set; }
    public string? DeviceId { get; set; }
    public int Size { get; set; }
    public long Cursor { get; set; }
    public DateTime CreatedAt { get; set; }

    /// <summary>
    /// Maps a stored row to what sync sends, once the row is already in memory.
    /// </summary>
    /// <remarks>
    /// Deliberately not used by the metadata-only query in <c>VersionRepo</c>: that one has to be
    /// translated to SQL, and a method call would be evaluated on the client, which means reading
    /// the payload column that the whole path exists to avoid.
    /// </remarks>
    public static SyncVersion From(Database.Schema.NoteVersion v, string? payload) {
        return new SyncVersion {
            Id = v.Id,
            NoteId = v.NoteId,
            VaultId = v.VaultId,
            ParentId = v.ParentId,
            MergeParentId = v.MergeParentId,
            IsSnapshot = v.IsSnapshot,
            IsNamed = v.IsNamed,
            Payload = payload,
            Label = v.Label,
            DeviceId = v.DeviceId,
            Size = v.Size,
            Cursor = v.Cursor,
            CreatedAt = v.CreatedAt
        };
    }

    /// <summary>The same row with its own ciphertext, for pushing a change that just happened.</summary>
    public static SyncVersion From(Database.Schema.NoteVersion v) => From(v, v.Payload);
}
