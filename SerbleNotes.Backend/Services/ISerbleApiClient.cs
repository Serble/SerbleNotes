using SerbleNotes.Backend.Database.Schema;
using SerbleNotes.Backend.Schema;

namespace SerbleNotes.Backend.Services;

public interface ISerbleApiClient {
    Task<TokenResponse?> Authenticate(string code);
    Task<TokenResponse?> GetAccessToken(string refreshToken);
    Task<SerbleUser?> GetUserInfo(string accessToken);
    Task<TokenResponse?> GetAccessToken(NotesUser user) => GetAccessToken(user.RefreshToken);
}
