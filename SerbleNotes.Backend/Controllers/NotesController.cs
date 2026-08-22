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
[Route("/api/notes")]
[Authorize]
public class NotesController(
    IVersionRepo versions,
    IVaultAccess access,
    INotesService noteService,
    IOptions<GeneralSettings> generalSettings) : ControllerBase {

    [HttpGet("{id}")]
    public async Task<ActionResult<Note>> GetNote(string id) {
        OwnedNote? owned = await access.GetOwnedNote(User, id);
        if (owned == null) {
            return NotFound(new { message = "Note not found." });
        }

        return Ok(owned.Note);
    }

    [HttpDelete("{id}")]
    public async Task<ActionResult> DeleteNote(string id) {
        OwnedNote? owned = await access.GetOwnedNote(User, id);
        if (owned == null) {
            return NotFound(new { message = "Note not found." });
        }

        await noteService.DeleteNote(owned.Vault, owned.Note, DeviceId);
        return NoContent();
    }

    [HttpPut("{id}/name")]
    public async Task<ActionResult<Note>> RenameNote(string id, RenameNoteRequest request) {
        OwnedNote? owned = await access.GetOwnedNote(User, id);
        if (owned == null) {
            return NotFound(new { message = "Note not found." });
        }

        await noteService.RenameNote(owned.Vault, owned.Note, request.Name, DeviceId);
        return Ok(owned.Note);
    }

    /// <summary>Full version DAG for a note. Payloads are ciphertext; the client replays them.</summary>
    [HttpGet("{id}/versions")]
    public async Task<ActionResult<IEnumerable<NoteVersion>>> GetVersions(string id) {
        OwnedNote? owned = await access.GetOwnedNote(User, id);
        if (owned == null) {
            return NotFound(new { message = "Note not found." });
        }

        return Ok(await versions.GetVersionsForNote(owned.Note.Id));
    }

    [HttpPost("{id}/versions")]
    public async Task<ActionResult<NoteVersion>> CreateVersion(string id, CreateVersionRequest request) {
        OwnedNote? owned = await access.GetOwnedNote(User, id);
        if (owned == null) {
            return NotFound(new { message = "Note not found." });
        }

        if (request.Payload.Length > generalSettings.Value.MaxVersionPayloadBytes) {
            return BadRequest(new { message = "This note is too large to save." });
        }

        if (await versions.GetVersion(request.Id) != null) {
            // Retries after a flaky connection are normal for a sync client, so an id that already
            // exists is success, not an error.
            return Ok(await versions.GetVersion(request.Id));
        }

        if (request.ParentId != null && await versions.GetVersion(request.ParentId) == null) {
            return BadRequest(new { message = "The parent version does not exist." });
        }

        if (!request.IsSnapshot && request.ParentId == null) {
            return BadRequest(new { message = "A diff version must have a parent." });
        }

        return Ok(await noteService.AppendVersion(owned.Vault, owned.Note, request, DeviceId));
    }

    private string? DeviceId => Request.Headers["X-Device-Id"].FirstOrDefault();
}
