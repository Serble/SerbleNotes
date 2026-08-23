using SerbleNotes.Backend.Database.Schema;

namespace SerbleNotes.Backend.Schema;

public class ChangesResponse {
    public string VaultId { get; set; } = null!;

    /// <summary>Cursor the client should send next time. Everything up to here is included below.</summary>
    public long Cursor { get; set; }

    public Note[] Notes { get; set; } = [];

    /// <summary>
    /// Ciphertext when the caller asked for bodies, metadata only when it did not. See
    /// <see cref="SyncVersion"/> for why the second shape exists.
    /// </summary>
    public SyncVersion[] Versions { get; set; } = [];
}
