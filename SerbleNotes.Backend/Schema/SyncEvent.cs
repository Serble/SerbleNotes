using SerbleNotes.Backend.Database.Schema;

namespace SerbleNotes.Backend.Schema;

/// <summary>
/// What the sync socket carries. One class for every direction and kind, because a socket frame is
/// read before anything knows what it is - <see cref="Kind"/> is what says how to read the rest.
/// </summary>
/// <remarks>
/// This used to be a bare "vault X moved to cursor N" and the client answered it with an HTTP pull.
/// The rows now travel with the notification, for two reasons. A pull is a round trip on a
/// connection that has just proved it works, and on a phone that is most of the delay between one
/// device typing and the other showing it. And the pull raced the notification: two writes close
/// together produced two events, two pulls, and whichever answered last decided what the client
/// believed - which is the sort of bug that only appears when two people are actually editing.
///
/// It stays a dumb relay. <see cref="Versions"/> holds the same ciphertext the database holds, and
/// the server can no more read a pushed version than a stored one.
/// </remarks>
public class SyncEvent {
    /// <summary>"change", "presence" or "pong".</summary>
    public string Kind { get; set; } = "change";

    public string? VaultId { get; set; }

    /// <summary>Where the vault stands after this change. Absent on presence and pong.</summary>
    public long Cursor { get; set; }

    /// <summary>Device that caused the change, so it can ignore the echo of its own write.</summary>
    public string? OriginDeviceId { get; set; }

    /// <summary>Notes that changed, so a rename or a delete needs no pull either.</summary>
    public Note[] Notes { get; set; } = [];

    /// <summary>
    /// Versions that changed, ciphertext included - unless one was too big to be worth pushing, in
    /// which case its payload is null and the client fetches that note the way it always has.
    /// </summary>
    public SyncVersion[] Versions { get; set; } = [];

    /// <summary>
    /// For "presence": the notes this user's *other* devices currently have open, one entry per
    /// device. Vaults are single-owner, so this says "you have this open somewhere else", never
    /// "somebody else is here" - and the client must not word it as though a second person exists.
    /// </summary>
    public PresenceEntry[] Present { get; set; } = [];
}

/// <summary>One device, and the note it is looking at.</summary>
public class PresenceEntry {
    public string DeviceId { get; set; } = null!;

    /// <summary>Null when that device is in the vault but has no note open.</summary>
    public string? NoteId { get; set; }
}

/// <summary>What a client sends up the socket.</summary>
public class SyncCommand {
    /// <summary>"ping" or "watch".</summary>
    public string Kind { get; set; } = "";

    /// <summary>For "watch": the vault this device is in, or null if it left.</summary>
    public string? VaultId { get; set; }

    /// <summary>For "watch": the note this device has open, or null if none.</summary>
    public string? NoteId { get; set; }
}
