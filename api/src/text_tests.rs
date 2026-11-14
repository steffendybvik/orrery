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
fn a_match_in_a_long_run_without_spaces_keeps_its_snippet() {
    // No space from 60 before the match until past its 100 after: the start stays put (ORR-1111).
    let body = format!("Lead in {}backup{} tail", "x".repeat(80), "y".repeat(200));
    let found = match_of(&body, &["backup".into()]);
    assert!(found.contains("backup") && found.starts_with('…') && found.ends_with('…'), "{found}");
    // A space past the match isn't taken for the start either.
    let found = match_of(&format!("{}backup and more", "z".repeat(70)), &["backup".into()]);
    assert!(found.contains("backup"), "{found}");
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
fn keys_from_names() {
    assert_eq!(key_for("Greenhouse"), "GRE");
    assert_eq!(key_for("3d printer"), "DPR");
    assert_eq!(key_for("go"), "GO");
    assert_eq!(key_for("!!! 42"), "ISS");
    assert_eq!(key_for("Straße"), "STR");
    assert_eq!(key_for("Epcot"), "EPCO");
    assert_eq!(key_for("mls"), "MLSP");
    assert_eq!(key_for("Doc"), "DOCP");
    assert_eq!(key_for("schedules"), "SCHE");
}

#[test]
fn natural_order() {
    let mut names = vec!["b", "Item 10", "item 9", "A", "é"];
    names.sort_by(|a, b| natural_cmp(a, b));
    assert_eq!(names, ["A", "b", "é", "item 9", "Item 10"]);
}
