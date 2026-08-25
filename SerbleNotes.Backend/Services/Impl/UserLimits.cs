using Microsoft.Extensions.Options;
using SerbleNotes.Backend.Config;
using SerbleNotes.Backend.Database.Repos;
using SerbleNotes.Backend.Database.Schema;
using SerbleNotes.Backend.Helpers;

namespace SerbleNotes.Backend.Services.Impl;

/// <summary>
/// Gives every account the configured defaults.
/// </summary>
/// <remarks>
/// <see cref="ForUser"/> does not look at the account yet. It takes one anyway because it is the
/// thing that will decide the answer, and adding the parameter later would mean changing every
/// caller rather than this file.
/// </remarks>
public class ConfiguredUserLimits(IOptions<GeneralSettings> settings, IVaultRepo vaults, INoteRepo notes)
    : IUserLimits {

    public Task<UserLimits> ForUser(string userId) {
        GeneralSettings general = settings.Value;

        return Task.FromResult(new UserLimits(
            MaxVersionPayloadBytes: general.MaxVersionPayloadBytes,
            MaxVaults: general.MaxVaultsPerUser,
            MaxNotesPerVault: general.MaxNotesPerVault,
            MaxStorageBytes: general.MaxStorageBytes));
    }

    public async Task<LimitRefusal?> CheckVersionWrite(Vault vault, int payloadBytes) {
        UserLimits allowed = await ForUser(vault.OwnerId);

        if (!UserLimits.Within(payloadBytes, allowed.MaxVersionPayloadBytes)) {
            return new LimitRefusal(400,
                "This note is too large to save. The most one save can carry is "
                + $"{Sizes.Describe(allowed.MaxVersionPayloadBytes)}.");
        }

        // A sum over the owner's vault rows - at most a hundred of them, by the vault limit - rather
        // than over their versions, which is what makes asking on the path of every save affordable.
        long stored = await vaults.TotalStorageForUser(vault.OwnerId);
        if (!UserLimits.Within(stored + payloadBytes, allowed.MaxStorageBytes)) {
            return new LimitRefusal(403,
                $"This account has reached its storage limit of {Sizes.Describe(allowed.MaxStorageBytes)}. "
                + "Deleting notes does not free space yet, because their history is kept.");
        }

        return null;
    }

    public async Task<LimitRefusal?> CheckNoteCreate(Vault vault) {
        UserLimits allowed = await ForUser(vault.OwnerId);

        if (!UserLimits.Within(await notes.CountNotesInVault(vault.Id) + 1, allowed.MaxNotesPerVault)) {
            return new LimitRefusal(403,
                $"This vault has reached its limit of {allowed.MaxNotesPerVault} notes.");
        }

        return null;
    }
}
