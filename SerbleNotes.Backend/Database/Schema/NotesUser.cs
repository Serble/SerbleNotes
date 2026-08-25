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

    /// <summary>
    /// Tokens issued before this moment are refused, or null when none have been revoked.
    ///
    /// This backend's JWTs are self-contained and long-lived, so without something to check them
    /// against there is no way to end a session at all: a token that leaks stays good until it
    /// expires, and "sign out everywhere" cannot be built. One timestamp on the row that every
    /// authenticated request already loads is the whole mechanism - see the OnTokenValidated
    /// handler in Program.cs.
    /// </summary>
    public DateTime? TokensValidAfter { get; set; }

    public DateTime CreatedAt { get; set; }
}
