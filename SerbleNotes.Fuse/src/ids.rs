//! Identifiers this client makes for itself: this device, a note, a version.
//!
//! Version ids are chosen by the client - a note is created offline and synced later, so the id has
//! to exist before the server has heard of it - and the server stores them in a 36-character
//! column. So this is a v4 UUID in its hyphenated form and nothing else will do.

/// A random v4 UUID, hyphenated: 36 characters.
pub fn random_id() -> String {
    let mut bytes = [0u8; 16];
    // A filesystem that silently wrote predictable version ids would collide with another device's
    // and have its writes refused as a 409, so there is no quietly-degrading fallback here.
    getrandom::getrandom(&mut bytes).expect("the operating system has no randomness available");

    bytes[6] = (bytes[6] & 0x0f) | 0x40; // Version 4.
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // Variant 1.

    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_id_is_the_36_characters_the_server_stores() {
        let id = random_id();
        assert_eq!(id.len(), 36, "the server's column is exactly this wide");
        assert_eq!(id.as_bytes()[14], b'4', "version 4");
    }

    #[test]
    fn two_ids_differ() {
        assert_ne!(random_id(), random_id());
    }

    #[test]
    fn the_variant_is_the_one_a_v4_uuid_has() {
        // Position 19 is the variant nibble, and it has to be 8, 9, a or b. Getting it wrong is
        // not cosmetic: these ids go in a column the server treats as unique across every vault,
        // and the backend refuses a collision with a 409 that no client can do anything about.
        for _ in 0..50 {
            let id = random_id();
            let variant = id.as_bytes()[19] as char;
            assert!(
                matches!(variant, '8' | '9' | 'a' | 'b'),
                "{id} has variant nibble {variant}"
            );
            assert_eq!(id.as_bytes()[14] as char, '4', "{id} is not version 4");
        }
    }

    #[test]
    fn the_bits_that_are_not_fixed_are_actually_random() {
        // Everything except the version and variant nibbles has to vary. A mask applied the wrong
        // way round leaves a byte constant, which reads as a perfectly well-formed UUID and
        // quietly throws away six bits of the randomness that keeps two devices from colliding.
        let ids: Vec<String> = (0..200).map(|_| random_id()).collect();

        // Skipping the four hyphens, the version nibble and the variant nibble - those are fixed
        // by the format and are checked above.
        for position in (0..36).filter(|p| !matches!(p, 8 | 13 | 14 | 18 | 19 | 23)) {
            let seen: std::collections::HashSet<u8> =
                ids.iter().map(|id| id.as_bytes()[position]).collect();
            assert!(
                seen.len() > 4,
                "position {position} only ever took {} value(s) across 200 ids",
                seen.len()
            );
        }
    }
}
