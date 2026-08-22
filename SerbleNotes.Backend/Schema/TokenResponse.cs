using System.Text.Json.Serialization;

namespace SerbleNotes.Backend.Schema;

public class TokenResponse {
    [JsonPropertyName("access_token")]
    public string AccessToken { get; set; } = null!;

    [JsonPropertyName("refresh_token")]
    public string RefreshToken { get; set; } = null!;
}
