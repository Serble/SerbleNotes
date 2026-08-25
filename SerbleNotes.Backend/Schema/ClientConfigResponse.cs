namespace SerbleNotes.Backend.Schema;

/// <summary>
/// What a client has to be told before it can do anything, which today is the Serble application id
/// the sign-in URL is built from.
/// </summary>
public class ClientConfigResponse {
    /// <summary>
    /// The OAuth <c>client_id</c> for this deployment. Empty when the server has not been configured
    /// with one, which the client reports rather than sending Serble a request it will refuse.
    /// </summary>
    public string SerbleAppId { get; set; } = null!;
}
