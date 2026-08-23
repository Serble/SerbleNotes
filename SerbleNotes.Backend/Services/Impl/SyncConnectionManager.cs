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
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<Guid, Connection>> _connections = new();

    private static readonly JsonSerializerOptions SerializerOptions = new() {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    /// <summary>
    /// One open socket, and what the device on the end of it is looking at.
    /// </summary>
    /// <remarks>
    /// A send lock, because a WebSocket permits exactly one send at a time and this process now has
    /// several reasons to write to the same socket at once: a change from another device, a presence
    /// update, and the pong answering a ping. Two overlapping sends corrupt the frame and the client
    /// sees a socket that closed for no reason it can report.
    /// </remarks>
    private sealed class Connection(WebSocket socket, string? deviceId) {
        public WebSocket Socket { get; } = socket;
        public string? DeviceId { get; } = deviceId;
        public SemaphoreSlim SendLock { get; } = new(1, 1);
        public string? VaultId { get; set; }
        public string? NoteId { get; set; }
    }

    public Guid Add(string userId, WebSocket socket, string? deviceId) {
        Guid connectionId = Guid.NewGuid();
        _connections.GetOrAdd(userId, _ => new ConcurrentDictionary<Guid, Connection>())[connectionId] =
            new Connection(socket, deviceId);
        return connectionId;
    }

    public void Remove(string userId, Guid connectionId) {
        if (!_connections.TryGetValue(userId, out ConcurrentDictionary<Guid, Connection>? sockets)) {
            return;
        }

        sockets.TryRemove(connectionId, out _);
        if (sockets.IsEmpty) {
            _connections.TryRemove(userId, out _);
        }
    }

    /// <summary>Records what a device has open, and tells the user's other devices about it.</summary>
    public async Task Watch(string userId, Guid connectionId, string? vaultId, string? noteId) {
        if (!_connections.TryGetValue(userId, out ConcurrentDictionary<Guid, Connection>? sockets) ||
            !sockets.TryGetValue(connectionId, out Connection? connection)) {
            return;
        }

        connection.VaultId = vaultId;
        connection.NoteId = noteId;
        await BroadcastPresence(userId);
    }

    /// <summary>
    /// Tells every one of this user's devices who is where.
    /// </summary>
    /// <remarks>
    /// Each device is sent the list with itself left out, so the client never has to work out which
    /// entry is its own reflection - and a device that is the only one open receives an empty list,
    /// which is exactly the message that clears a stale "open elsewhere" mark.
    /// </remarks>
    public async Task BroadcastPresence(string userId) {
        if (!_connections.TryGetValue(userId, out ConcurrentDictionary<Guid, Connection>? sockets)) {
            return;
        }

        foreach ((Guid connectionId, Connection connection) in sockets) {
            PresenceEntry[] others = sockets
                .Where(other => other.Key != connectionId && other.Value.VaultId != null)
                .Select(other => new PresenceEntry {
                    DeviceId = other.Value.DeviceId ?? other.Key.ToString(),
                    NoteId = other.Value.NoteId
                })
                .ToArray();

            await SendTo(userId, connectionId, connection, new SyncEvent {
                Kind = "presence",
                VaultId = connection.VaultId,
                Present = others
            });
        }
    }

    public async Task SendToUser(string userId, SyncEvent syncEvent) {
        if (!_connections.TryGetValue(userId, out ConcurrentDictionary<Guid, Connection>? sockets)) {
            return;
        }

        foreach ((Guid connectionId, Connection connection) in sockets) {
            await SendTo(userId, connectionId, connection, syncEvent);
        }
    }

    /// <summary>Answers one connection. Used for the pong, which nobody else should see.</summary>
    public async Task SendToConnection(string userId, Guid connectionId, SyncEvent syncEvent) {
        if (_connections.TryGetValue(userId, out ConcurrentDictionary<Guid, Connection>? sockets) &&
            sockets.TryGetValue(connectionId, out Connection? connection)) {
            await SendTo(userId, connectionId, connection, syncEvent);
        }
    }

    private async Task SendTo(string userId, Guid connectionId, Connection connection, SyncEvent syncEvent) {
        if (connection.Socket.State != WebSocketState.Open) {
            Remove(userId, connectionId);
            return;
        }

        byte[] payload = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(syncEvent, SerializerOptions));

        await connection.SendLock.WaitAsync();
        try {
            await connection.Socket.SendAsync(payload, WebSocketMessageType.Text, true, CancellationToken.None);
        }
        catch (Exception e) {
            // A dead socket must never break the write that triggered the notification: the data is
            // already committed, and the client will catch up from its cursor when it reconnects.
            logger.LogDebug(e, "Dropping sync socket for user {UserId}", userId);
            Remove(userId, connectionId);
        }
        finally {
            connection.SendLock.Release();
        }
    }
}
