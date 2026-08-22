using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;
using SerbleNotes.Backend.Config;
using SerbleNotes.Backend.Database.Schema;

namespace SerbleNotes.Backend.Services.Impl;

public class JwtManager(IOptions<JwtSettings> settings) : IJwtManager {
    private readonly JwtSettings _settings = settings.Value;

    public string GenerateToken(NotesUser user) {
        JwtSecurityTokenHandler tokenHandler = new();
        byte[] key = Encoding.UTF8.GetBytes(_settings.Secret);
        SecurityTokenDescriptor tokenDescriptor = new() {
            Subject = new ClaimsIdentity([
                new Claim(ClaimTypes.NameIdentifier, user.Id),
                new Claim(ClaimTypes.Name, user.Username)
            ]),
            Expires = DateTime.UtcNow.AddHours(_settings.ExpiryHours),
            Issuer = _settings.Issuer,
            Audience = _settings.Audience,
            SigningCredentials = new SigningCredentials(new SymmetricSecurityKey(key), SecurityAlgorithms.HmacSha256Signature)
        };
        SecurityToken token = tokenHandler.CreateToken(tokenDescriptor);
        return tokenHandler.WriteToken(token);
    }
}
