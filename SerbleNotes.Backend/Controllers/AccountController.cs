using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using SerbleNotes.Backend.Database.Repos;
using SerbleNotes.Backend.Database.Schema;
using SerbleNotes.Backend.Schema;
using SerbleNotes.Backend.Services;

namespace SerbleNotes.Backend.Controllers;

[ApiController]
[Route("/api/account")]
public class AccountController(ISerbleApiClient serbleApi, IUserRepo users, IJwtManager jwt) : ControllerBase {

    [HttpPost]
    public async Task<ActionResult<AuthenticateResponse>> Post(AuthenticateRequest request) {
        TokenResponse? tokenResponse = await serbleApi.Authenticate(request.Code);
        if (tokenResponse == null) {
            return BadRequest(new { message = "Invalid authentication code. Please try logging in again." });
        }

        SerbleUser info = await serbleApi.GetUserInfo(tokenResponse.AccessToken) ?? throw new Exception("Failed to get user info");
        if (info.Username == null!) {
            throw new Exception("User info does not contain a username: " + JsonSerializer.Serialize(info));
        }

        NotesUser user = await users.EnsureUser(info.Id, info.Username, tokenResponse.RefreshToken);

        if (user.IsBanned) {
            return StatusCode(403, new { message = "Your account has been banned. Please contact support if you believe this is an error." });
        }

        string backendToken = jwt.GenerateToken(user);
        return Ok(new AuthenticateResponse {
            AccessToken = backendToken
        });
    }

    [Authorize]
    [HttpGet]
    public async Task<ActionResult<NotesUser>> Get() {
        string? userId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (userId == null) {
            return Unauthorized(new { message = "Authentication required." });
        }

        NotesUser? user = await users.GetUser(userId);
        if (user == null) {
            return Unauthorized(new { message = "User not found." });
        }

        return Ok(user);
    }
}
