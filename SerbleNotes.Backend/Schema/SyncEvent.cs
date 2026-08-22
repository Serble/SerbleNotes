namespace SerbleNotes.Backend.Schema;

/// <summary>
/// Pushed over the sync socket to say "this vault moved on". It carries no content - the client pulls
/// the encrypted versions it is missing over HTTP.
/// </summary>
public class SyncEvent {
    public string VaultId { get; set; } = null!;

    public long Cursor { get; set; }

    /// <summary>Device that caused the change, so it can ignore the echo of its own write.</summary>
    public string? OriginDeviceId { get; set; }
}
