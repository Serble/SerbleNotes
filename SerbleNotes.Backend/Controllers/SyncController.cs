using System.Net.WebSockets;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using SerbleNotes.Backend.Schema;
using SerbleNotes.Backend.Services.Impl;

namespace SerbleNotes.Backend.Controllers;

[ApiController]
[Route("/api/sync")]
[Authorize]
public class SyncController(SyncConnectionManager connections, ILogger<SyncController> logger) : ControllerBase {

    private static readonly JsonSerializerOptions SerializerOptions = new() {
        PropertyNameCaseInsensitive = true
    };

    /// <summary>
    /// Long-lived socket carrying change notifications, presence, and the pong that answers a
    /// client's ping. Browsers can't set headers on a WebSocket handshake, so the token arrives as a
    /// query parameter (see the JwtBearer setup in Program.cs), and so does the device id.
    /// </summary>
    [HttpGet]
    public async Task Get() {
        if (!HttpContext.WebSockets.IsWebSocketRequest) {
            Response.StatusCode = StatusCodes.Status400BadRequest;
            return;
        }

        string? userId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (userId == null) {
            Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }

        string? deviceId = Request.Query["device_id"];

        using WebSocket socket = await HttpContext.WebSockets.AcceptWebSocketAsync();
        Guid connectionId = connections.Add(userId, socket, deviceId);
        logger.LogDebug("Sync socket opened for user {UserId}", userId);

        try {
            await ReadUntilClosed(socket, userId, connectionId);
        }
        catch (WebSocketException e) {
            // Clients drop off mid-stream all the time; nothing here is worth an error log.
            logger.LogDebug(e, "Sync socket for user {UserId} ended abruptly", userId);
        }
        finally {
            connections.Remove(userId, connectionId);
            // The device that just went away was possibly the reason another one was showing "open
            // elsewhere". Telling the rest is what clears that mark, and a socket that dies without
            // a close frame reaches this the same way a polite one does.
            await connections.BroadcastPresence(userId);
        }
    }

    /// <summary>
    /// The receive loop. It keeps the socket open, surfaces the close handshake, and handles the two
    /// things a client says: "are you there" and "this is what I have open".
    /// </summary>
    private async Task ReadUntilClosed(WebSocket socket, string userId, Guid connectionId) {
        byte[] buffer = new byte[4096];

        while (socket.State == WebSocketState.Open) {
            WebSocketReceiveResult result = await socket.ReceiveAsync(buffer, CancellationToken.None);
            if (result.MessageType == WebSocketMessageType.Close) {
                await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None);
                return;
            }

            if (result.MessageType != WebSocketMessageType.Text || !result.EndOfMessage) {
                // Nothing a client sends is big enough to be split, so a fragment is not ours.
                continue;
            }

            SyncCommand? command;
            try {
                command = JsonSerializer.Deserialize<SyncCommand>(
                    Encoding.UTF8.GetString(buffer, 0, result.Count), SerializerOptions);
            }
            catch (JsonException) {
                // A frame we can't read is not worth tearing the connection down for.
                continue;
            }

            switch (command?.Kind) {
                case "ping":
                    // The point of this is not the content, it is that a reply has to travel back
                    // over the same path. A client that stops hearing pongs knows its socket is
                    // dead - which is the one thing a half-open TCP connection will not tell it.
                    await connections.SendToConnection(userId, connectionId, new SyncEvent { Kind = "pong" });
                    break;

                case "watch":
                    await connections.Watch(userId, connectionId, command.VaultId, command.NoteId);
                    break;
            }
        }
    }
}
