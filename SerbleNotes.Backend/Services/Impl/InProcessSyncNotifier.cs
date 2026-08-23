using SerbleNotes.Backend.Database.Schema;
using SerbleNotes.Backend.Schema;

namespace SerbleNotes.Backend.Services.Impl;

/// <summary>
/// Single-process fan-out. Correct as long as the backend runs as one instance; the moment it scales
/// out, this is replaced by a Redis pub/sub implementation of the same interface that publishes the
/// event and lets every instance deliver it to its own sockets.
/// </summary>
public class InProcessSyncNotifier(SyncConnectionManager connections) : ISyncNotifier {

    /// <summary>
    /// Above this, a version's ciphertext is left out of the notification.
    /// </summary>
    /// <remarks>
    /// Pushing a diff costs nothing - they are a few hundred bytes. Pushing a full snapshot of a
    /// large note costs that much to every device the user has open, including ones that are not
    /// looking at that note and may never open it. 256 KB is far above any diff and below the size
    /// at which that trade stops being worth it; past it the client fetches the note itself, which
    /// is the path it already uses for every note it opens.
    /// </remarks>
    private const int MaxPushedPayloadBytes = 256 * 1024;

    public Task NotifyVaultChanged(
        string ownerId,
        string vaultId,
        long cursor,
        string? originDeviceId,
        Note[] notes,
        SyncVersion[] versions) {

        SyncVersion[] pushed = versions.Select(Trim).ToArray();

        return connections.SendToUser(ownerId, new SyncEvent {
            Kind = "change",
            VaultId = vaultId,
            Cursor = cursor,
            OriginDeviceId = originDeviceId,
            Notes = notes,
            Versions = pushed
        });
    }

    private static SyncVersion Trim(SyncVersion version) {
        if (version.Payload == null || version.Payload.Length <= MaxPushedPayloadBytes) {
            return version;
        }

        // A copy, because the caller's instance may be the one that was just written to the database.
        return new SyncVersion {
            Id = version.Id,
            NoteId = version.NoteId,
            VaultId = version.VaultId,
            ParentId = version.ParentId,
            MergeParentId = version.MergeParentId,
            IsSnapshot = version.IsSnapshot,
            IsNamed = version.IsNamed,
            Label = version.Label,
            DeviceId = version.DeviceId,
            Cursor = version.Cursor,
            CreatedAt = version.CreatedAt,
            Size = version.Size,
            Payload = null
        };
    }
}
