using System.Net.WebSockets;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using SerbleNotes.Backend.Services.Impl;

namespace SerbleNotes.Backend.Controllers;

[ApiController]
[Route("/api/sync")]
[Authorize]
public class SyncController(SyncConnectionManager connections, ILogger<SyncController> logger) : ControllerBase {

    /// <summary>
    /// Long-lived socket that carries change notifications only. Browsers can't set headers on a
    /// WebSocket handshake, so the token arrives as a query parameter (see the JwtBearer setup in
    /// Program.cs).
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

        using WebSocket socket = await HttpContext.WebSockets.AcceptWebSocketAsync();
        Guid connectionId = connections.Add(userId, socket);
        logger.LogDebug("Sync socket opened for user {UserId}", userId);

        try {
            await ReadUntilClosed(socket);
        }
        catch (WebSocketException e) {
            // Clients drop off mid-stream all the time; nothing here is worth an error log.
            logger.LogDebug(e, "Sync socket for user {UserId} ended abruptly", userId);
        }
        finally {
            connections.Remove(userId, connectionId);
        }
    }

    /// <summary>
    /// The client never sends anything meaningful, but the receive loop is what keeps the socket open
    /// and surfaces the close handshake.
    /// </summary>
    private static async Task ReadUntilClosed(WebSocket socket) {
        byte[] buffer = new byte[1024];

        while (socket.State == WebSocketState.Open) {
            WebSocketReceiveResult result = await socket.ReceiveAsync(buffer, CancellationToken.None);
            if (result.MessageType == WebSocketMessageType.Close) {
                await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None);
                return;
            }
        }
    }
}
