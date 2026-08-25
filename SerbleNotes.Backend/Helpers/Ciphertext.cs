using System.Buffers.Text;

namespace SerbleNotes.Backend.Helpers;

/// <summary>
/// Turning the base64 a client sends into the bytes the database stores.
/// </summary>
public static class Ciphertext {

    /// <summary>
    /// Decodes a base64 payload, or reports that it was not base64 at all.
    /// </summary>
    /// <remarks>
    /// The server cannot check that a payload is a *valid* sealed blob - that is the whole point of
    /// it - but it can check that the string is the encoding it claims to be, and it has to: the
    /// column takes bytes now, so a malformed one would otherwise be an unhandled exception and a
    /// 500 for what is a bad request. This is the only place ciphertext is decoded.
    /// </remarks>
    public static bool TryDecode(string base64, out byte[] bytes) {
        // Sized from the encoded length rather than guessed at, so a large payload is not copied
        // through a growing buffer on a path that runs on every save.
        byte[] buffer = new byte[Base64.GetMaxDecodedFromUtf8Length(base64.Length)];

        if (Convert.TryFromBase64String(base64, buffer, out int written)) {
            bytes = buffer.AsSpan(0, written).ToArray();
            return true;
        }

        bytes = [];
        return false;
    }
}
