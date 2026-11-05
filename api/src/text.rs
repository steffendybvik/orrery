// What the docs domain does with text, as the Nuxt server does it (web/server/store/schema.ts, web/shared/roadmap):
// a doc's summary, the text around a search's hit, a title as an id, and the A–Z order lists are in.
use regex::Regex;
use std::cmp::Ordering;
use std::sync::LazyLock;
use unicode_normalization::char::is_combining_mark;
use unicode_normalization::UnicodeNormalization;

static FENCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(```|~~~)").unwrap());
static SKIPPED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(#|<!--|\||---|\*\*\*)").unwrap());
static PICTURE_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*!\[[^\]]*\]\([^)]*\)\s*$").unwrap());
static PICTURE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"!\[[^\]]*\]\([^)]*\)").unwrap());
static LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[([^\]]*)\]\([^)]*\)").unwrap());
static LIST_MARK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(>|[-*+]|\d+\.)\s+").unwrap());
static MARKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[*_`]+").unwrap());
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
static NOT_SLUG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^a-z0-9]+").unwrap());
static SLUG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9][a-z0-9-]{0,39}$").unwrap());
static FULL_DOC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^doc-.+-[a-z2-7]{8}$").unwrap());

/// A doc's first paragraph as plain text (no headings, code, pictures or Markdown marks), cut to about 160 characters.
pub fn summary_of(body: &str) -> String {
    let mut fenced = false;
    let mut lines: Vec<&str> = vec![];
    for line in body.split('\n') {
        if FENCE.is_match(line) {
            fenced = !fenced
        } else if fenced || SKIPPED.is_match(line) || PICTURE_LINE.is_match(line) || line.trim().is_empty() {
            if !lines.is_empty() {
                break;
            }
        } else {
            lines.push(line)
        }
    }
    let text = lines.join(" ");
    let text = PICTURE.replace_all(&text, "");
    let text = LINK.replace_all(&text, "$1");
    let text = LIST_MARK.replace(&text, "");
    let text = MARKS.replace_all(&text, "");
    let text = SPACES.replace_all(&text, " ");
    let text: Vec<char> = text.trim().chars().collect();
    if text.len() <= 160 {
        return text.iter().collect();
    }
    let cut = &text[..160];
    let space = cut.iter().rposition(|c| *c == ' ');
    let end = match space {
        Some(at) if at > 100 => at,
        _ => 160,
    };
    let mut kept: String = cut[..end].iter().collect();
    if kept.ends_with([',', ';', ':', '.']) {
        kept.pop();
    }
    format!("{kept}…")
}

/// A doc's summary: an artifact's text is HTML, which has none to show.
pub fn doc_summary_of(kind: &str, body: &str) -> String {
    if kind == "artifact" {
        String::new()
    } else {
        summary_of(body)
    }
}

fn index_of(haystack: &[char], needle: &[char], from: usize) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    (from..=haystack.len() - needle.len()).find(|&i| haystack[i..i + needle.len()] == *needle)
}

/// The text around the first of `words` (lowercase) in a doc's text, on one line, about 160 characters; empty when only
/// its title has them.
pub fn match_of(body: &str, words: &[String]) -> String {
    let chars: Vec<char> = body.chars().collect();
    // Lowercased one for one, so an index in it is one in the text.
    let lower: Vec<char> = chars.iter().map(|c| c.to_lowercase().next().unwrap_or(*c)).collect();
    let Some(at) = words.iter().filter_map(|w| index_of(&lower, &w.chars().collect::<Vec<_>>(), 0)).min() else {
        return String::new();
    };
    let len = chars.len();
    let mut start = at.saturating_sub(60);
    let mut end = (at + 100).min(len);
    if start > 0 {
        start = index_of(&chars, &[' '], start).map(|i| i + 1).unwrap_or(start)
    }
    if end < len {
        let space = chars[..=end.min(len - 1)].iter().rposition(|c| *c == ' ');
        if let Some(space) = space.filter(|s| *s > at) {
            end = space
        }
    }
    let middle: String = chars[start..end].iter().collect();
    let middle = SPACES.replace_all(&middle, " ");
    format!("{}{}{}", if start > 0 { "…" } else { "" }, middle.trim(), if end < len { "…" } else { "" })
}

/// A name as an id: lowercase letters, digits and dashes, at most 40.
pub fn slugify(text: &str) -> String {
    let lower: String = text.to_lowercase().nfkd().collect();
    let dashed = NOT_SLUG.replace_all(&lower, "-");
    let trimmed: String = dashed.trim_matches('-').chars().take(40).collect();
    trimmed.trim_end_matches('-').to_string()
}

pub fn is_slug(id: &str) -> bool {
    SLUG.is_match(id)
}

/// Whether a doc's id reads as a full one, from any board: `doc-ideas-x7k2m9qd`.
pub fn looks_full_doc(id: &str) -> bool {
    FULL_DOC.is_match(id)
}

/// The form of a doc's id to paste anywhere (ORR-674).
pub fn full_doc_id(id: &str, uid: &str) -> String {
    format!("doc-{id}-{uid}")
}

/// The doc id inside a full one with this `uid`; none for anything else, another board's full id included.
pub fn short_doc_id(id: &str, uid: &str) -> Option<String> {
    let tail = format!("-{uid}");
    if uid.is_empty() || !id.starts_with("doc-") || id.len() <= 4 + tail.len() || !id.ends_with(&tail) {
        return None;
    }
    Some(id[4..id.len() - tail.len()].to_string())
}

pub fn base_letters(text: &str) -> Vec<char> {
    text.nfkd().filter(|c| !is_combining_mark(*c)).flat_map(char::to_lowercase).collect()
}

/// A–Z as the Nuxt server sorts (`localeCompare` in English, ignoring case and accents, numbers by their value). Close to
/// it, not the same: ICU's order of punctuation against letters isn't copied.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (a, b) = (base_letters(a), base_letters(b));
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        if a[i].is_ascii_digit() && b[j].is_ascii_digit() {
            let (si, sj) = (i, j);
            while i < a.len() && a[i].is_ascii_digit() {
                i += 1
            }
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1
            }
            let x: String = a[si..i].iter().collect::<String>().trim_start_matches('0').to_string();
            let y: String = b[sj..j].iter().collect::<String>().trim_start_matches('0').to_string();
            let order = x.len().cmp(&y.len()).then(x.cmp(&y));
            if order != Ordering::Equal {
                return order;
            }
        } else {
            let order = a[i].cmp(&b[j]);
            if order != Ordering::Equal {
                return order;
            }
            i += 1;
            j += 1;
        }
    }
    (a.len() - i).cmp(&(b.len() - j))
}

/// Up to `n` characters, as JavaScript's `slice(0, n)` keeps them (by character here, not UTF-16 unit).
pub fn first_chars(text: &str, n: usize) -> String {
    text.chars().take(n).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summaries_skip_headings_pictures_and_marks() {
        let body = "# Decision: ids\n\n![logo](/api/uploads/x)\n\nIssues get the project's **prefix** and a number, [handed out](https://x.y) by `orrery`.\nNever reused.\n\nMore later.";
        assert_eq!(summary_of(body), "Issues get the project's prefix and a number, handed out by orrery. Never reused.");
        let long = format!("```sh\npnpm dev\n```\n\n{}", "word ".repeat(60));
        let summary = summary_of(&long);
        assert!(summary.ends_with("word…") && summary.chars().count() <= 161, "{summary}");
    }

    #[test]
    fn matches_show_the_text_around_a_hit() {
        let body = "Issues get the project's **prefix** and a number, [handed out](https://x.y) by `orrery`.\nNever reused.";
        assert!(match_of(body, &["reused".into()]).contains("Never reused."));
        assert_eq!(match_of("nothing", &["else".into()]), "");
    }

    #[test]
    fn slugs_and_full_ids() {
        assert_eq!(slugify("How joints work"), "how-joints-work");
        // As the Nuxt server makes it: an accent, split off, is a dash.
        assert_eq!(slugify("Café — déjà vu!"), "cafe-de-ja-vu");
        assert_eq!(short_doc_id("doc-ideas-x7k2m9qd", "x7k2m9qd").as_deref(), Some("ideas"));
        assert_eq!(short_doc_id("doc-ideas-x7k2m9qd", "aaaaaaaa"), None);
        assert!(looks_full_doc("doc-ideas-x7k2m3qd") && !looks_full_doc("ideas"));
    }

    #[test]
    fn natural_order() {
        let mut names = vec!["b", "Item 10", "item 9", "A", "é"];
        names.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(names, ["A", "b", "é", "item 9", "Item 10"]);
    }
}
