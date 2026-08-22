namespace SerbleNotes.Backend.Schema;

public class SerbleUser {
    public string Id { get; set; } = null!;
    public string Username { get; set; } = null!;
    public bool VerifiedEmail { get; set; }
}
