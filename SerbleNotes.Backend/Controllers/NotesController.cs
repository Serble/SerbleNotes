using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using SerbleNotes.Backend.Database.Repos;
using SerbleNotes.Backend.Database.Schema;
using SerbleNotes.Backend.Helpers;
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
    IUserLimits limits) : ControllerBase {

    [HttpGet("{id}")]
    public async Task<ActionResult<Note>> GetNote(string id) {
        NoteAccess? note = await access.GetNote(User, id);
        if (note == null) {
            return NotFound(new { message = "Note not found." });
        }

        return Ok(note.Note);
    }

    [HttpDelete("{id}")]
    public async Task<ActionResult> DeleteNote(string id) {
        NoteAccess? note = await access.GetNote(User, id);
        if (note == null) {
            return NotFound(new { message = "Note not found." });
        }

        await noteService.DeleteNote(note.Vault, note.Note, DeviceId);
        return NoContent();
    }

    [HttpPut("{id}/name")]
    public async Task<ActionResult<Note>> RenameNote(string id, RenameNoteRequest request) {
        NoteAccess? note = await access.GetNote(User, id);
        if (note == null) {
            return NotFound(new { message = "Note not found." });
        }

        await noteService.RenameNote(note.Vault, note.Note, request.Name, DeviceId);
        return Ok(note.Note);
    }

    /// <summary>
    /// Versions of a note. Payloads are ciphertext; the client replays them.
    /// </summary>
    /// <remarks>
    /// With <paramref name="ids"/>, only those versions. That is the ordinary case and the reason
    /// this parameter exists: rebuilding a note needs the versions from its head back to the nearest
    /// snapshot - about ten of them - and the client already knows which those are, because opening
    /// the vault gave it every version's parent pointer without any of the ciphertext. Sending the
    /// whole history so it could use the last ten of it was most of what opening a note cost.
    ///
    /// Without it, everything. Kept because the client falls back to it when the chain it wants
    /// cannot be worked out from what it holds - a history with no snapshot in it, or a parent whose
    /// metadata never arrived. Rare, and the answer to it must not be a note that will not open.
    /// </remarks>
    [HttpGet("{id}/versions")]
    public async Task<ActionResult<IEnumerable<NoteVersion>>> GetVersions(string id, [FromQuery] string? ids = null) {
        NoteAccess? note = await access.GetNote(User, id);
        if (note == null) {
            return NotFound(new { message = "Note not found." });
        }

        if (ids == null) {
            return Ok(await versions.GetVersionsForNote(note.Note.Id));
        }

        string[] wanted = ids.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        if (wanted.Length > MaxVersionsPerRequest) {
            return BadRequest(new {
                message = $"Ask for at most {MaxVersionsPerRequest} versions at a time."
            });
        }

        return Ok(await versions.GetVersionsByIds(note.Note.Id, wanted));
    }

    /// <summary>
    /// How many versions one request may name. The client batches to stay under it; the limit is
    /// here so that a query built by hand cannot ask for a list longer than the URL that carried it.
    /// </summary>
    private const int MaxVersionsPerRequest = 200;

    [HttpPost("{id}/versions")]
    public async Task<ActionResult<NoteVersion>> CreateVersion(string id, CreateVersionRequest request) {
        NoteAccess? note = await access.GetNote(User, id);
        if (note == null) {
            return NotFound(new { message = "Note not found." });
        }

        if (!Ciphertext.TryDecode(request.Payload, out byte[] payload)) {
            return BadRequest(new { message = "That version's payload is not valid base64." });
        }

        LimitRefusal? refusal = await limits.CheckVersionWrite(note.Vault, payload.Length);
        if (refusal != null) {
            return StatusCode(refusal.StatusCode, new { message = refusal.Message });
        }

        // Both lookups below are scoped to this note, and that is the point of them rather than a
        // tidiness. Version ids are chosen by clients and unique across the whole table, so asking
        // "does this id exist" without saying where would answer yes for a row in a vault the caller
        // has never been near - and then return it, ciphertext and all, as though the caller had
        // just written it. Scoping turns both questions into ones about the note in the URL, which
        // access has already been checked for.
        NoteVersion? existing = await versions.GetVersionInNote(note.Note.Id, request.Id);
        if (existing != null) {
            // Retries after a flaky connection are normal for a sync client, so an id that already
            // exists on this note is success, not an error.
            return Ok(existing);
        }

        // The id is not on this note, so if it exists at all it belongs to another one - possibly in
        // a vault this caller cannot see. Refused as a conflict, with nothing about the row that has
        // it: without this the insert dies on the primary key and returns a 500 for what is a
        // perfectly ordinary bad request.
        if (await versions.VersionExists(request.Id)) {
            return Conflict(new { message = "A version with that id already exists." });
        }

        if (request.ParentId != null && await versions.GetVersionInNote(note.Note.Id, request.ParentId) == null) {
            return BadRequest(new { message = "The parent version does not exist." });
        }

        if (!request.IsSnapshot && request.ParentId == null) {
            return BadRequest(new { message = "A diff version must have a parent." });
        }

        return Ok(await noteService.AppendVersion(note.Vault, note.Note, request, payload, DeviceId));
    }

    private string? DeviceId => Request.Headers["X-Device-Id"].FirstOrDefault();
}
