using SerbleNotes.Backend.Database.Schema;

namespace SerbleNotes.Backend.Schema;

public class ChangesResponse {
    public string VaultId { get; set; } = null!;

    /// <summary>Cursor the client should send next time. Everything up to here is included below.</summary>
    public long Cursor { get; set; }

    public Note[] Notes { get; set; } = [];

    public NoteVersion[] Versions { get; set; } = [];
}
