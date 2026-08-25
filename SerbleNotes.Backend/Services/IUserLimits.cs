using SerbleNotes.Backend.Database.Schema;

namespace SerbleNotes.Backend.Services;

/// <summary>
/// What one account is allowed to store, and whether a given write stays inside it.
/// </summary>
/// <remarks>
/// A service rather than <c>IOptions&lt;GeneralSettings&gt;</c> read in each controller, because
/// limits are about to stop being the same for everybody - a plan, a grandfathered account, an admin
/// with none - and every call site that read the config directly would have to be found and changed.
/// Asking per account from the start means that change is one class.
///
/// The checks live here too rather than in the controllers, because each one is a limit plus the
/// query that measures it, and splitting those leaves the expensive half somewhere it can be
/// forgotten.
/// </remarks>
public interface IUserLimits {
    /// <summary>The limits in force for this account.</summary>
    Task<UserLimits> ForUser(string userId);

    /// <summary>
    /// Whether one more version of this size may be written to this vault, or why not.
    /// </summary>
    /// <remarks>
    /// Measured against the *owner's* allowance rather than the caller's: the owner is who the vault
    /// is charged to, and a vault with more than one holder must not spend whichever of them happens
    /// to be typing.
    /// </remarks>
    Task<LimitRefusal?> CheckVersionWrite(Vault vault, int payloadBytes);

    /// <summary>Whether one more note may be created in this vault, or why not.</summary>
    Task<LimitRefusal?> CheckNoteCreate(Vault vault);
}

/// <summary>
/// One account's limits. -1 means unlimited, everywhere it can appear.
/// </summary>
/// <remarks>
/// Every field is a resource the service pays for, not a judgement about what someone should want
/// with their own notes - see the "inform, never forbid" rule, which these sit outside. They are set
/// high enough that nobody ordinary meets one, and each is refused with a sentence naming the limit
/// that was reached.
///
/// There is deliberately no cap on versions per note. It is the one limit of this kind whose failure
/// mode is refusing to save something the user has already written, and
/// <see cref="MaxStorageBytes"/> covers the same ground without ever being the reason a note cannot
/// be saved for the first time.
/// </remarks>
public record UserLimits(
    int MaxVersionPayloadBytes,
    int MaxVaults,
    int MaxNotesPerVault,
    long MaxStorageBytes) {

    /// <summary>Whether <paramref name="proposed"/> is within a limit, treating -1 as unlimited.</summary>
    public static bool Within(long proposed, long limit) => limit == -1 || proposed <= limit;
}

/// <summary>A refused write, and the sentence to tell the user why.</summary>
public record LimitRefusal(int StatusCode, string Message);
