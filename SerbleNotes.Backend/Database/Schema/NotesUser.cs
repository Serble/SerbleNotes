using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;

namespace SerbleNotes.Backend.Database.Schema;

public class NotesUser {
    [Key, StringLength(64)]
    public string Id { get; set; } = null!;

    [StringLength(64)]
    public string Username { get; set; } = null!;

    [JsonIgnore, StringLength(512)]
    public string RefreshToken { get; set; } = null!;

    public bool IsBanned { get; set; }

    public bool IsAdmin { get; set; }

    public DateTime CreatedAt { get; set; }
}
