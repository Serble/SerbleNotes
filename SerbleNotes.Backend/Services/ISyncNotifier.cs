using SerbleNotes.Backend.Database.Schema;
using SerbleNotes.Backend.Schema;

namespace SerbleNotes.Backend.Services;

public interface ISyncNotifier {
    /// <summary>
    /// Tells a user's other devices that a vault moved on, and hands them the rows that moved it.
    /// </summary>
    /// <remarks>
    /// The rows are the same ciphertext the database holds. Carrying them is what lets the other
    /// device show the edit without a round trip of its own, and it is not a weakening of anything:
    /// this server could not read a version on the way out any more than it could sitting still.
    ///
    /// A payload big enough to be worth not pushing is sent with <c>Payload</c> null, and the client
    /// falls back to fetching that note - so this is an optimisation the client never has to trust.
    /// </remarks>
    Task NotifyVaultChanged(
        string ownerId,
        string vaultId,
        long cursor,
        string? originDeviceId,
        Note[] notes,
        SyncVersion[] versions);
}
