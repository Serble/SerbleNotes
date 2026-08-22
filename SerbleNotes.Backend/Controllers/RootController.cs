using Microsoft.AspNetCore.Mvc;

namespace SerbleNotes.Backend.Controllers;

[ApiController]
[Route("/api")]
public class RootController : ControllerBase {

    [HttpGet]
    public ActionResult Get() {
        return Ok(new { service = "SerbleNotes.Backend", status = "ok" });
    }
}
