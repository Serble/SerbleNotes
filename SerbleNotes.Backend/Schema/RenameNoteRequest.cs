using System.ComponentModel.DataAnnotations;

namespace SerbleNotes.Backend.Schema;

public class RenameNoteRequest {
    /// <summary>
    /// The new sealed name. Renaming is a metadata change, not an edit: it does not append a version,
    /// which is what lets the filesystem map it onto a plain rename later.
    /// </summary>
    [Required, StringLength(2048)]
    public string Name { get; set; } = null!;
}
