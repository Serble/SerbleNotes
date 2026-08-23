using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using SerbleNotes.Backend.Config;
using SerbleNotes.Backend.Database.Repos;
using SerbleNotes.Backend.Database.Schema;
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
    IOptions<GeneralSettings> generalSettings) : ControllerBase {

    [HttpGet]
    public async Task<ActionResult<IEnumerable<Vault>>> GetVaults() {
        string? userId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (userId == null) {
            return Unauthorized(new { message = "Authentication required." });
        }

        return Ok(await vaults.GetVaultsForUser(userId));
    }

    [HttpPost]
    public async Task<ActionResult<Vault>> CreateVault(CreateVaultRequest request) {
        string? userId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (userId == null) {
            return Unauthorized(new { message = "Authentication required." });
        }

        if (request.Encrypted && string.IsNullOrWhiteSpace(request.KdfSalt)) {
            return BadRequest(new { message = "An encrypted vault must supply a KDF salt." });
        }

        int maxVaults = generalSettings.Value.MaxVaultsPerUser;
        if (maxVaults != -1 && await vaults.CountVaultsForUser(userId) >= maxVaults) {
            return StatusCode(403, new { message = $"You have reached the limit of {maxVaults} vaults." });
        }

        DateTime now = DateTime.UtcNow;
        Vault vault = new() {
            Id = Guid.NewGuid().ToString(),
            Name = request.Name,
            OwnerId = userId,
            Encrypted = request.Encrypted,
            WrappedKey = request.WrappedKey,
            KdfSalt = request.KdfSalt,
            KdfParams = request.KdfParams,
            Cursor = 0,
            CreatedAt = now,
            UpdatedAt = now
        };
        await vaults.CreateVault(vault);

        return Ok(vault);
    }

    [HttpGet("{id}")]
    public async Task<ActionResult<Vault>> GetVault(string id) {
        Vault? vault = await access.GetOwnedVault(User, id);
        if (vault == null) {
            return NotFound(new { message = "Vault not found." });
        }

        return Ok(vault);
    }

    /// <summary>
    /// Replaces a vault's key material after the user changed its password.
    ///
    /// This is metadata, not an edit: the vault key inside the new blob is the same key as before, so
    /// every note, name and stored version stays exactly as it is and other devices that already hold
    /// the key carry on working. Nothing here bumps the sync cursor, because nothing a client syncs
    /// has changed - sending every device to /changes for a blob none of them re-reads would be work
    /// for nothing.
    /// </summary>
    [HttpPut("{id}/password")]
    public async Task<ActionResult<Vault>> ChangeVaultPassword(string id, ChangeVaultPasswordRequest request) {
        Vault? vault = await access.GetOwnedVault(User, id);
        if (vault == null) {
            return NotFound(new { message = "Vault not found." });
        }

        // An unencrypted vault's "wrapped" key is the key itself, in the clear. Accepting a password
        // for one would leave a vault the server has already read looking as though it were private.
        if (!vault.Encrypted) {
            return BadRequest(new { message = "This vault is not encrypted, so it has no password." });
        }

        vault.WrappedKey = request.WrappedKey;
        vault.KdfSalt = request.KdfSalt;
        vault.KdfParams = request.KdfParams;
        vault.UpdatedAt = DateTime.UtcNow;
        await vaults.UpdateVault(vault);

        return Ok(vault);
    }

    [HttpDelete("{id}")]
    public async Task<ActionResult> DeleteVault(string id) {
        Vault? vault = await access.GetOwnedVault(User, id);
        if (vault == null) {
            return NotFound(new { message = "Vault not found." });
        }

        vault.Deleted = true;
        vault.UpdatedAt = DateTime.UtcNow;
        await vaults.UpdateVault(vault);

        // A password change re-wraps the key and touches no note, so there are no rows to carry.
        await sync.NotifyVaultChanged(vault.OwnerId, vault.Id, vault.Cursor, DeviceId, [], []);
        return NoContent();
    }

    [HttpGet("{id}/notes")]
    public async Task<ActionResult<IEnumerable<Note>>> GetNotes(string id) {
        Vault? vault = await access.GetOwnedVault(User, id);
        if (vault == null) {
            return NotFound(new { message = "Vault not found." });
        }

        return Ok(await notes.GetNotesInVault(vault.Id));
    }

    [HttpPost("{id}/notes")]
    public async Task<ActionResult<Note>> CreateNote(string id, CreateNoteRequest request) {
        Vault? vault = await access.GetOwnedVault(User, id);
        if (vault == null) {
            return NotFound(new { message = "Vault not found." });
        }

        if (request.InitialVersion.Payload.Length > generalSettings.Value.MaxVersionPayloadBytes) {
            return BadRequest(new { message = "This note is too large to save." });
        }

        if (await notes.GetNote(request.Id) != null) {
            return Conflict(new { message = "A note with that id already exists." });
        }

        return Ok(await noteService.CreateNote(vault, request, DeviceId));
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
        Vault? vault = await access.GetOwnedVault(User, id);
        if (vault == null) {
            return NotFound(new { message = "Vault not found." });
        }

        Note[] changedNotes = await notes.GetChangedNotes(vault.Id, since);
        SyncVersion[] changedVersions = await versions.GetChangedVersions(vault.Id, since, bodies);

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
            VaultId = vault.Id,
            Cursor = highest,
            Notes = changedNotes,
            Versions = changedVersions
        });
    }

    private string? DeviceId => Request.Headers["X-Device-Id"].FirstOrDefault();
}
