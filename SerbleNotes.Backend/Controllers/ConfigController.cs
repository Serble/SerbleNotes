using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using SerbleNotes.Backend.Config;
using SerbleNotes.Backend.Schema;

namespace SerbleNotes.Backend.Controllers;

/// <summary>
/// The settings a client needs before it has an account, served so it does not have to be built with
/// them.
/// </summary>
/// <remarks>
/// The Serble application id used to be compiled into the frontend from VITE_SERBLE_APP_ID, which
/// meant the id and the client secret it is paired with lived in two places and a deployment pointed
/// at a different Serble app needed both changed together. The backend already holds it - the token
/// exchange sends the same id - so it is the one place it comes from now.
///
/// Anonymous on purpose: this is what the sign-in screen needs, and there is no session yet. Nothing
/// here is a secret - the application id travels in the URL of every sign-in - and the client secret
/// beside it in configuration is never part of the answer.
/// </remarks>
[ApiController]
[Route("/api/config")]
public class ConfigController(IOptions<SerbleApiSettings> serble) : ControllerBase {

    [HttpGet]
    public ActionResult<ClientConfigResponse> Get() {
        return Ok(new ClientConfigResponse {
            SerbleAppId = serble.Value.ClientId ?? ""
        });
    }
}
