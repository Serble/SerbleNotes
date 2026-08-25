using SerbleNotes.Backend.Helpers;

namespace SerbleNotes.Backend.Tests;

/// <summary>
/// The two small functions on the write path, both of which have a wrong answer that looks fine.
/// </summary>
public class HelperTests {

    // --- decoding a payload -----------------------------------------------------------------

    [Fact]
    public void Base64_decodes_to_the_bytes_it_stands_for() {
        Assert.True(Ciphertext.TryDecode(Convert.ToBase64String([1, 2, 250]), out byte[] bytes));
        Assert.Equal<byte[]>([1, 2, 250], bytes);
    }

    [Fact]
    public void The_decoded_array_is_exactly_the_right_length() {
        // Sized from the *encoded* length, which over-estimates: a decode that returned the whole
        // buffer would silently pad every payload with zeros and Size would count them.
        Assert.True(Ciphertext.TryDecode(Convert.ToBase64String(new byte[100]), out byte[] bytes));
        Assert.Equal(100, bytes.Length);
    }

    [Theory]
    [InlineData("not!valid!base64")]
    [InlineData("=")]
    [InlineData("a")]
    [InlineData("!!!!")]
    public void Something_that_is_not_base64_is_refused_rather_than_throwing(string input) {
        Assert.False(Ciphertext.TryDecode(input, out _));
    }

    [Fact]
    public void An_empty_payload_is_valid_base64_for_no_bytes() {
        // The server cannot know whether an empty sealed blob is meaningful - that is the client's
        // question. It only has to be sure the string was the encoding it claimed to be.
        Assert.True(Ciphertext.TryDecode("", out byte[] bytes));
        Assert.Empty(bytes);
    }

    [Fact]
    public void A_large_payload_round_trips_unchanged() {
        byte[] original = new byte[512 * 1024];
        Random.Shared.NextBytes(original);

        Assert.True(Ciphertext.TryDecode(Convert.ToBase64String(original), out byte[] bytes));
        Assert.Equal(original, bytes);
    }

    // --- describing a size ------------------------------------------------------------------

    [Theory]
    [InlineData(0, "0 bytes")]
    [InlineData(512, "512 bytes")]
    [InlineData(1024, "1 KB")]
    [InlineData(1536, "1.5 KB")]
    [InlineData(102400, "100 KB")]
    [InlineData(4 * 1024 * 1024, "4 MB")]
    [InlineData(2L * 1024 * 1024 * 1024, "2 GB")]
    public void A_size_is_described_in_the_unit_it_fills(long bytes, string expected) {
        Assert.Equal(expected, Sizes.Describe(bytes));
    }

    [Fact]
    public void A_limit_below_a_megabyte_never_describes_itself_as_zero() {
        // "0 MB" told somebody their note was too big to fit in nothing. Any positive limit has to
        // come out as a positive number, whatever unit that takes.
        foreach (long bytes in new long[] { 1, 100, 1023, 100 * 1024, 1024 * 1024 - 1 }) {
            string described = Sizes.Describe(bytes);
            Assert.False(described.StartsWith("0 "), $"{bytes} came out as {described}");
        }
    }

    [Fact]
    public void A_size_beyond_the_largest_unit_stops_there_rather_than_running_off_the_end() {
        // The unit walk is bounded by the length of the table it indexes. One step further is an
        // index out of range, on the path that builds the message explaining a refused write.
        Assert.Equal("1 TB", Sizes.Describe(1024L * 1024 * 1024 * 1024));
        Assert.EndsWith(" TB", Sizes.Describe(5000L * 1024 * 1024 * 1024));

        // Past the last unit it has a name for, and at the largest value it can ever be handed.
        Assert.EndsWith(" TB", Sizes.Describe(1024L * 1024 * 1024 * 1024 * 1024));
        Assert.EndsWith(" TB", Sizes.Describe(long.MaxValue));
    }

    [Fact]
    public void A_whole_number_of_units_reads_as_a_whole_number() {
        Assert.Equal("2 MB", Sizes.Describe(2 * 1024 * 1024));
        Assert.DoesNotContain(".0", Sizes.Describe(2 * 1024 * 1024));
    }
}
