//! Shared fixtures for the core test suite.
//!
//! The corpus below is the point of most of these tests: every one of these shapes is something a
//! real note can contain, and each has broken a diff or crypto implementation somewhere before.

#![allow(dead_code)]

use serblenotes_core::KdfParams;

/// Argon2id settings that are valid but fast. Real vaults use 64 MiB / 3 passes; running that in
/// every test would make the suite unusable, and the cost parameters are not what is under test.
pub fn fast_kdf() -> KdfParams {
    KdfParams::new(8, 1, 1)
}

/// Text shapes that have to survive a full round trip. Each is (name, content) so a failure names
/// the shape that broke rather than dumping the payload.
pub fn text_corpus() -> Vec<(&'static str, String)> {
    vec![
        ("empty", String::new()),
        ("single space", " ".to_string()),
        ("one line no newline", "just one line".to_string()),
        ("one line with newline", "just one line\n".to_string()),
        ("trailing blank lines", "text\n\n\n".to_string()),
        ("leading blank lines", "\n\n\ntext\n".to_string()),
        ("windows line endings", "one\r\ntwo\r\nthree\r\n".to_string()),
        ("mixed line endings", "one\r\ntwo\nthree\r\n".to_string()),
        ("tabs and spaces", "\tindented\n    spaced\n\t \tmixed\n".to_string()),
        ("unicode", "héllo wörld — em dash, ellipsis…\n".to_string()),
        ("emoji", "🔐 vault 🗒️ note ✅ done\nfamily: 👨‍👩‍👧‍👦\n".to_string()),
        ("cjk", "日本語のノート\n中文笔记\n한국어 메모\n".to_string()),
        ("rtl", "מסמך בעברית\nنص عربي\n".to_string()),
        ("combining marks", "e\u{0301}gal a\u{0300} co\u{0302}te\u{0301}\n".to_string()),
        ("zero width", "in\u{200b}visible\u{200d}joiner\n".to_string()),
        ("markdown", "# Title\n\n- item one\n- item two\n\n```rust\nfn main() {}\n```\n\n> quote\n".to_string()),
        // A note *about* diffs is the nastiest case: its own content looks like patch syntax, and a
        // diff of it has to survive being serialised to text and parsed back.
        ("diff-like content", "--- a/file.txt\n+++ b/file.txt\n@@ -1,3 +1,3 @@\n-old line\n+new line\n context\n".to_string()),
        ("conflict markers in content", "<<<<<<< ours\nmine\n=======\ntheirs\n>>>>>>> theirs\n".to_string()),
        ("no newline marker text", "text\n\\ No newline at end of file\n".to_string()),
        ("lines starting with plus", "+one\n+two\n-three\n".to_string()),
        ("very long line", format!("{}\n", "x".repeat(50_000))),
        ("many lines", (0..5_000).map(|i| format!("line {i}\n")).collect::<String>()),
        ("nul and control chars", "before\u{0}after\u{7}bell\n".to_string()),
        ("json payload", "{\"key\": \"value\", \"n\": [1,2,3]}\n".to_string()),
        ("only newlines", "\n\n\n\n".to_string()),
    ]
}

/// A plausible editing session: the same note, edited step by step.
pub fn editing_session() -> Vec<String> {
    vec![
        "# Shopping\n".to_string(),
        "# Shopping\n\n- milk\n".to_string(),
        "# Shopping\n\n- milk\n- bread\n".to_string(),
        "# Shopping list\n\n- milk\n- bread\n".to_string(),
        "# Shopping list\n\n- milk\n- sourdough bread\n".to_string(),
        "# Shopping list\n\n- milk\n- sourdough bread\n- jam\n".to_string(),
        "# Shopping list\n\n- oat milk\n- sourdough bread\n- jam\n".to_string(),
        "# Shopping list\n\n- oat milk\n- jam\n".to_string(),
        "# Shopping list\n\n- oat milk\n- jam\n\n## Later\n\n- coffee\n".to_string(),
        "".to_string(),
        "# Starting over\n".to_string(),
    ]
}
