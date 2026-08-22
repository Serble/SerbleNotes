using SerbleNotes.Backend.Database.Schema;

namespace SerbleNotes.Backend.Database.Repos;

public interface IUserRepo {
    Task<NotesUser?> GetUser(string id);

    /// <summary>
    /// Returns the account for a Serble user, creating it on first sight and refreshing the details
    /// we mirror from Serble either way. Safe against two logins for the same account arriving at
    /// once - see the implementation for why that is not a theoretical concern.
    /// </summary>
    Task<NotesUser> EnsureUser(string id, string username, string refreshToken);

    Task UpdateUser(NotesUser user);
}
