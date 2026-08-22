using Microsoft.EntityFrameworkCore;
using SerbleNotes.Backend.Database.Schema;

namespace SerbleNotes.Backend.Database.Repos.Impl;

public class UserRepo(NotesDatabaseContext context) : IUserRepo {

    public Task<NotesUser?> GetUser(string id) {
        return context.Users.FindAsync(id).AsTask();
    }

    public async Task<NotesUser> EnsureUser(string id, string username, string refreshToken) {
        NotesUser? user = await GetUser(id);

        if (user != null) {
            user.Username = username;
            user.RefreshToken = refreshToken;
            await context.SaveChangesAsync();
            return user;
        }

        user = new NotesUser {
            Id = id,
            Username = username,
            RefreshToken = refreshToken,
            CreatedAt = DateTime.UtcNow
        };
        context.Users.Add(user);

        try {
            await context.SaveChangesAsync();
            return user;
        }
        catch (DbUpdateException) {
            // Another login for the same account beat us between the read above and this insert.
            // That is an ordinary race, not an error: a browser firing the callback twice does it,
            // and so do two devices signing in at the same moment. Whoever won, the row we wanted
            // now exists, so adopt theirs instead of failing the login.
            context.Entry(user).State = EntityState.Detached;

            NotesUser? winner = await GetUser(id);
            if (winner == null) {
                // The insert failed for some other reason and the row still isn't there - that is a
                // real failure and must not be swallowed.
                throw;
            }

            winner.Username = username;
            winner.RefreshToken = refreshToken;
            await context.SaveChangesAsync();
            return winner;
        }
    }

    public Task UpdateUser(NotesUser user) {
        context.Users.Update(user);
        return context.SaveChangesAsync();
    }
}
