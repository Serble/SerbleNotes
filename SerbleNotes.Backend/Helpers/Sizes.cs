namespace SerbleNotes.Backend.Helpers;

/// <summary>
/// Byte counts as a person would say them, for the sentence that explains a refused write.
/// </summary>
public static class Sizes {

    /// <summary>
    /// Formats a byte count in the largest unit it fills, to at most one decimal place.
    /// </summary>
    /// <remarks>
    /// A limit is only ever refused with the number that refused it, so this cannot round to zero:
    /// dividing straight to megabytes turned a 100 KB cap into "0 MB", which tells the user their
    /// note is too big to fit in nothing. Configured limits are megabytes and gigabytes today, but
    /// the message has to survive whatever a limit is set to.
    /// </remarks>
    public static string Describe(long bytes) {
        string[] units = ["bytes", "KB", "MB", "GB", "TB"];

        double value = bytes;
        int unit = 0;
        while (value >= 1024 && unit < units.Length - 1) {
            value /= 1024;
            unit += 1;
        }

        // Whole numbers read as whole numbers: "2 GB", not "2.0 GB".
        string number = unit == 0 || value == Math.Floor(value)
            ? value.ToString("0")
            : value.ToString("0.#");

        return $"{number} {units[unit]}";
    }
}
