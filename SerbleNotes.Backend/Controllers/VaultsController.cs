using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using SerbleNotes.Backend.Database.Repos;
using SerbleNotes.Backend.Database.Schema;
using SerbleNotes.Backend.Helpers;
using SerbleNotes.Backend.Schema;
using SerbleNotes.Backend.Services;

namespace SerbleNotes.Backend.Controllers;

[ApiController]
[Route("/api/vaults")]
[Authorize]
public class VaultsController(
    IVaultRepo vaults,
    INoteRepo notes,
    IVersionRepo versions,
    IVaultAccess access,
    INotesService noteService,
    ISyncNotifier sync,
    IUserLimits limits) : ControllerBase {

    [HttpGet]
    public async Task<ActionResult<IEnumerable<VaultResponse>>> GetVaults() {
        string? userId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (userId == null) {
            return Unauthorized(new { message = "Authentication required." });
        }

        VaultKey[] keys = await vaults.GetVaultsForUser(userId);
        return Ok(keys.Select(key => VaultResponse.From(key.VaultNavigation, key)));
    }

    [HttpPost]
    public async Task<ActionResult<VaultResponse>> CreateVault(CreateVaultRequest request) {
        string? userId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (userId == null) {
            return Unauthorized(new { message = "Authentication required." });
        }

        if (request.Encrypted && string.IsNullOrWhiteSpace(request.KdfSalt)) {
            return BadRequest(new { message = "An encrypted vault must supply a KDF salt." });
        }

        UserLimits allowed = await limits.ForUser(userId);
        if (!UserLimits.Within(await vaults.CountVaultsForUser(userId) + 1, allowed.MaxVaults)) {
            return StatusCode(403, new { message = $"You have reached the limit of {allowed.MaxVaults} vaults." });
        }

        DateTime now = DateTime.UtcNow;
        Vault vault = new() {
            Id = Guid.NewGuid().ToString(),
            Name = request.Name,
            OwnerId = userId,
            Encrypted = request.Encrypted,
            Cursor = 0,
            StorageBytes = 0,
            CreatedAt = now,
            UpdatedAt = now
        };
        await vaults.CreateVault(vault);

        // The owner's key is written as its own row, exactly as a second person's would be. There is
        // no "the owner's key lives on the vault, everyone else's lives here" case to get wrong.
        VaultKey key = new() {
            VaultId = vault.Id,
            UserId = userId,
            WrappedKey = request.WrappedKey,
            KdfSalt = request.KdfSalt,
            KdfParams = request.KdfParams,
            CreatedAt = now
        };
        await vaults.CreateKey(key);

        return Ok(VaultResponse.From(vault, key));
    }

    [HttpGet("{id}")]
    public async Task<ActionResult<VaultResponse>> GetVault(string id) {
        VaultAccess? vault = await access.GetVault(User, id);
        if (vault == null) {
            return NotFound(new { message = "Vault not found." });
        }

        return Ok(VaultResponse.From(vault));
    }

    /// <summary>
    /// Replaces the caller's key material after they changed this vault's password.
    ///
    /// This is metadata, not an edit: the vault key inside the new blob is the same key as before, so
    /// every note, name and stored version stays exactly as it is and other devices that already hold
    /// the key carry on working. Nothing here bumps the sync cursor, because nothing a client syncs
    /// has changed - sending every device to /changes for a blob none of them re-reads would be work
    /// for nothing.
    ///
    /// It rewraps one key row, which is the caller's own. When a vault can have several holders, each
    /// one's password is theirs alone and this is already the right shape for that; what it will need
    /// then is a decision about whether a password change should evict the others, which is a product
    /// question rather than a mechanical one.
    /// </summary>
    [HttpPut("{id}/password")]
    public async Task<ActionResult<VaultResponse>> ChangeVaultPassword(string id, ChangeVaultPasswordRequest request) {
        VaultAccess? vault = await access.GetVault(User, id);
        if (vault == null) {
            return NotFound(new { message = "Vault not found." });
        }

        // An unencrypted vault's "wrapped" key is the key itself, in the clear. Accepting a password
        // for one would leave a vault the server has already read looking as though it were private.
        if (!vault.Vault.Encrypted) {
            return BadRequest(new { message = "This vault is not encrypted, so it has no password." });
        }

        VaultKey key = vault.Key;
        key.WrappedKey = request.WrappedKey;
        key.KdfSalt = request.KdfSalt;
        key.KdfParams = request.KdfParams;
        await vaults.UpdateKey(key);

        return Ok(VaultResponse.From(vault.Vault, key));
    }

    [HttpDelete("{id}")]
    public async Task<ActionResult> DeleteVault(string id) {
        VaultAccess? vault = await access.GetVault(User, id);
        if (vault == null) {
            return NotFound(new { message = "Vault not found." });
        }

        if (!vault.IsOwner) {
            return StatusCode(403, new { message = "Only the owner of a vault can delete it." });
        }

        await vaults.MarkVaultDeleted(vault.Vault.Id, DateTime.UtcNow);

        // A vault delete touches no note, so there are no rows to carry.
        await sync.NotifyVaultChanged(vault.Vault.OwnerId, vault.Vault.Id, vault.Vault.Cursor, DeviceId, [], []);
        return NoContent();
    }

    [HttpGet("{id}/notes")]
    public async Task<ActionResult<IEnumerable<Note>>> GetNotes(string id) {
        VaultAccess? vault = await access.GetVault(User, id);
        if (vault == null) {
            return NotFound(new { message = "Vault not found." });
        }

        return Ok(await notes.GetNotesInVault(vault.Vault.Id));
    }

    [HttpPost("{id}/notes")]
    public async Task<ActionResult<Note>> CreateNote(string id, CreateNoteRequest request) {
        VaultAccess? vault = await access.GetVault(User, id);
        if (vault == null) {
            return NotFound(new { message = "Vault not found." });
        }

        if (!Ciphertext.TryDecode(request.InitialVersion.Payload, out byte[] payload)) {
            return BadRequest(new { message = "That version's payload is not valid base64." });
        }

        LimitRefusal? refusal = await limits.CheckVersionWrite(vault.Vault, payload.Length)
                                ?? await limits.CheckNoteCreate(vault.Vault);
        if (refusal != null) {
            return StatusCode(refusal.StatusCode, new { message = refusal.Message });
        }

        if (await notes.GetNote(request.Id) != null) {
            return Conflict(new { message = "A note with that id already exists." });
        }

        return Ok(await noteService.CreateNote(vault.Vault, request, payload, DeviceId));
    }

    /// <summary>
    /// Everything in this vault past the client's cursor. This is the only read path sync needs: the
    /// socket says "something changed", the client calls here, and the payloads it gets back are
    /// ciphertext it decrypts locally.
    /// </summary>
    [HttpGet("{id}/changes")]
    public async Task<ActionResult<ChangesResponse>> GetChanges(
        string id,
        [FromQuery] long since = 0,
        [FromQuery] bool bodies = true) {
        VaultAccess? vault = await access.GetVault(User, id);
        if (vault == null) {
            return NotFound(new { message = "Vault not found." });
        }

        Note[] changedNotes = await notes.GetChangedNotes(vault.Vault.Id, since);
        SyncVersion[] changedVersions = await versions.GetChangedVersions(vault.Vault.Id, since, bodies);

        // Read the cursor from the rows actually returned, not from the vault: another write can land
        // between the two queries, and reporting the vault's newer cursor would skip that change.
        long highest = since;
        foreach (Note note in changedNotes) {
            highest = Math.Max(highest, note.Cursor);
        }
        foreach (SyncVersion version in changedVersions) {
            highest = Math.Max(highest, version.Cursor);
        }

        return Ok(new ChangesResponse {
            VaultId = vault.Vault.Id,
            Cursor = highest,
            Notes = changedNotes,
            Versions = changedVersions
        });
    }

    private string? DeviceId => Request.Headers["X-Device-Id"].FirstOrDefault();
}
