namespace SerbleNotes.Backend.Config;

public class GeneralSettings {
    /// <summary>Largest ciphertext payload accepted for a single version, in bytes.</summary>
    public int MaxVersionPayloadBytes { get; set; } = 4 * 1024 * 1024;

    /// <summary>Vaults a single account may own. -1 for unlimited.</summary>
    public int MaxVaultsPerUser { get; set; } = 100;
}
