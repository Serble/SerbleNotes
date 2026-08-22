using SerbleNotes.Backend.Schema;

namespace SerbleNotes.Backend.Services.Impl;

/// <summary>
/// Single-process fan-out. Correct as long as the backend runs as one instance; the moment it scales
/// out, this is replaced by a Redis pub/sub implementation of the same interface that publishes the
/// event and lets every instance deliver it to its own sockets.
/// </summary>
public class InProcessSyncNotifier(SyncConnectionManager connections) : ISyncNotifier {

    public Task NotifyVaultChanged(string ownerId, string vaultId, long cursor, string? originDeviceId) {
        return connections.SendToUser(ownerId, new SyncEvent {
            VaultId = vaultId,
            Cursor = cursor,
            OriginDeviceId = originDeviceId
        });
    }
}
