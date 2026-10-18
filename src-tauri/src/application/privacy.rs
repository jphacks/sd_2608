//! 試作版のマスクを移植。生タイトルを履歴へ入れる前に適用する。
use regex::Regex;
use std::sync::LazyLock;
static MASKS: LazyLock<Vec<(Regex, &str)>> = LazyLock::new(|| {
    [
        (r"(?i)https?://\S+", "[URL]"),
        (r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "[メール]"),
        (r"(?i)[A-Z]:\\Users\\[^\\\s]+", r"C:\Users\[ユーザー]"),
        (
            r"(?i)(api[_ -]?key|token|password|secret|authorization)\s*[:=]\s*(?:(?:bearer|basic)\s+)?\S+",
            "[認証情報]",
        ),
        (r"\bsk-[A-Za-z0-9_-]{8,}", "[キー]"),
    ]
    .into_iter()
    .map(|(pattern, replacement)| (Regex::new(pattern).expect("static mask"), replacement))
    .collect()
});
pub fn mask(text: &str) -> String {
    masked(text, 200)
}
pub fn mask_ocr(text: &str) -> String {
    // 改行を除去して単語や認証値を結合しない。
    masked(&text.replace(['\r', '\n', '\t'], " "), 2_000)
}
fn masked(text: &str, limit: usize) -> String {
    // 切り詰めてからマスクすると長い認証値の末尾を残すため、上限までの全体を先に処理。
    let mut result: String = text
        .chars()
        .filter(|c| !c.is_control())
        .take(32_768)
        .collect();
    for (pattern, replacement) in MASKS.iter() {
        result = pattern.replace_all(&result, *replacement).into_owned();
    }
    result.trim().chars().take(limit).collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn masks_prototype_patterns_before_truncation_and_drops_controls() {
        let input = "https://example.test/private user@example.test C:\\Users\\Alice\\work api_key=private-token sk-1234567890\n";
        let masked = mask(input);
        for secret in [
            "example.test",
            "Alice",
            "private-token",
            "sk-1234567890",
            "\n",
        ] {
            assert!(!masked.contains(secret));
        }
        for label in ["[URL]", "[メール]", "[ユーザー]", "[認証情報]", "[キー]"] {
            assert!(masked.contains(label));
        }
        assert_eq!(
            mask(&format!("token={} end", "a".repeat(2000))),
            "[認証情報] end"
        );
        assert_eq!(
            mask("Authorization: Bearer dummy-access-token"),
            "[認証情報]"
        );
        assert_eq!(mask(&"あ".repeat(300)).chars().count(), 200);
        assert_eq!(
            mask_ocr("first line\nsecond line\napi_key=secret\nnotes"),
            "first line second line [認証情報] notes"
        );
    }
}
