using System.Text.Json;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Options;
using SerbleNotes.Backend.Config;
using SerbleNotes.Backend.Schema;

namespace SerbleNotes.Backend.Services.Impl;

public class SerbleApiClient(HttpClient httpClient, IOptions<SerbleApiSettings> settings) : ISerbleApiClient {

    public async Task<TokenResponse?> Authenticate(string code) {
        Dictionary<string, string?> query = new() {
            { "code", code },
            { "client_id", settings.Value.ClientId },
            { "client_secret", settings.Value.ClientSecret },
            { "grant_type", "authorization_code" }
        };

        string url = QueryHelpers.AddQueryString(
            $"{settings.Value.BaseUrl}oauth/token/refresh", query);

        HttpResponseMessage response =
            await httpClient.PostAsync(url, new StringContent(""));

        if (!response.IsSuccessStatusCode) {
            return null;
        }

        string responseContent = await response.Content.ReadAsStringAsync();
        return JsonSerializer.Deserialize<TokenResponse>(responseContent);
    }

    public async Task<TokenResponse?> GetAccessToken(string refreshToken) {
        Dictionary<string, string?> query = new() {
            { "refresh_token", refreshToken },
            { "client_id", settings.Value.ClientId },
            { "client_secret", settings.Value.ClientSecret },
            { "grant_type", "authorization_code" }
        };

        string url = QueryHelpers.AddQueryString(
            $"{settings.Value.BaseUrl}oauth/token/access", query);

        HttpResponseMessage response =
            await httpClient.PostAsync(url, new StringContent(""));

        if (!response.IsSuccessStatusCode) {
            return null;
        }

        string responseContent = await response.Content.ReadAsStringAsync();
        return JsonSerializer.Deserialize<TokenResponse>(responseContent);
    }

    // /account
    public Task<SerbleUser?> GetUserInfo(string accessToken) {
        httpClient.DefaultRequestHeaders.Remove("SerbleAuth");
        httpClient.DefaultRequestHeaders.Add("SerbleAuth", "App " + accessToken);
        return httpClient.GetFromJsonAsync<SerbleUser>($"{settings.Value.BaseUrl}account");
    }
}
