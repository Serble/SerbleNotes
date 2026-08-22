using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using SerbleNotes.Backend.Schema;

namespace SerbleNotes.Backend.Services.Impl;

/// <summary>
/// Holds the live sync sockets for this process, keyed by user. Vaults are single-owner for now, so
/// "notify the vault" means "notify that user's other devices".
/// </summary>
public class SyncConnectionManager(ILogger<SyncConnectionManager> logger) {
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<Guid, WebSocket>> _connections = new();

    private static readonly JsonSerializerOptions SerializerOptions = new() {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public Guid Add(string userId, WebSocket socket) {
        Guid connectionId = Guid.NewGuid();
        _connections.GetOrAdd(userId, _ => new ConcurrentDictionary<Guid, WebSocket>())[connectionId] = socket;
        return connectionId;
    }

    public void Remove(string userId, Guid connectionId) {
        if (!_connections.TryGetValue(userId, out ConcurrentDictionary<Guid, WebSocket>? sockets)) {
            return;
        }

        sockets.TryRemove(connectionId, out _);
        if (sockets.IsEmpty) {
            _connections.TryRemove(userId, out _);
        }
    }

    public async Task SendToUser(string userId, SyncEvent syncEvent) {
        if (!_connections.TryGetValue(userId, out ConcurrentDictionary<Guid, WebSocket>? sockets)) {
            return;
        }

        byte[] payload = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(syncEvent, SerializerOptions));

        foreach ((Guid connectionId, WebSocket socket) in sockets) {
            if (socket.State != WebSocketState.Open) {
                Remove(userId, connectionId);
                continue;
            }

            try {
                await socket.SendAsync(payload, WebSocketMessageType.Text, true, CancellationToken.None);
            }
            catch (Exception e) {
                // A dead socket must never break the write that triggered the notification: the data is
                // already committed, and the client will catch up from its cursor when it reconnects.
                logger.LogDebug(e, "Dropping sync socket for user {UserId}", userId);
                Remove(userId, connectionId);
            }
        }
    }
}
