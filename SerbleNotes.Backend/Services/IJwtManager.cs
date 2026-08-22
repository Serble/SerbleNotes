using SerbleNotes.Backend.Database.Schema;

namespace SerbleNotes.Backend.Services;

public interface IJwtManager {
    string GenerateToken(NotesUser user);
}
