namespace SerbleNotes.Backend.Services;

public interface ISyncNotifier {
    /// <summary>
    /// Tells a user's other devices that a vault moved on. Never carries content - the client pulls
    /// the encrypted versions itself.
    /// </summary>
    Task NotifyVaultChanged(string ownerId, string vaultId, long cursor, string? originDeviceId);
}
