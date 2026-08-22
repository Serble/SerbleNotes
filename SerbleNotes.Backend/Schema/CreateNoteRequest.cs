using System.ComponentModel.DataAnnotations;

namespace SerbleNotes.Backend.Schema;

public class CreateNoteRequest {
    /// <summary>
    /// Client-chosen id. Clients create notes offline and sync later, so the id has to exist before
    /// the server has ever heard of the note.
    /// </summary>
    [Required, StringLength(36, MinimumLength = 36)]
    public string Id { get; set; } = null!;

    /// <summary>The note's sealed name, including any folder path. Opaque to the server.</summary>
    [Required, StringLength(2048)]
    public string Name { get; set; } = null!;

    /// <summary>First version of the note, always a snapshot.</summary>
    [Required]
    public CreateVersionRequest InitialVersion { get; set; } = null!;
}
