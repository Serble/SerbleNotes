namespace SerbleNotes.Backend.Config;

/// <summary>
/// The default limits every account gets, bound from the "General" configuration section.
/// </summary>
/// <remarks>
/// Read through <c>IUserLimits</c> rather than injected directly, so that the day limits vary per
/// account there is one place to change and no caller to revisit. See that interface.
/// </remarks>
public class GeneralSettings {
    /// <summary>Largest ciphertext payload accepted for a single version, in bytes.</summary>
    public int MaxVersionPayloadBytes { get; set; } = 4 * 1024 * 1024;

    /// <summary>Vaults a single account may own. -1 for unlimited.</summary>
    public int MaxVaultsPerUser { get; set; } = 100;

    /// <summary>Notes in one vault, tombstones included. -1 for unlimited.</summary>
    public int MaxNotesPerVault { get; set; } = 10_000;

    /// <summary>
    /// Ciphertext an account may store across every vault it owns. -1 for unlimited.
    ///
    /// This is the limit that actually bounds the service: a note's history grows without end as it
    /// is edited, and every tenth save is a full copy of it, so an account's real cost is its
    /// version history rather than its note count.
    /// </summary>
    public long MaxStorageBytes { get; set; } = 2L * 1024 * 1024 * 1024;
}
