use super::*;

#[test]
fn orders_titles_as_locale_compare_does() {
    let mut titles = vec!["b", "B", "a", "Ä", "item 9", "item 10"];
    titles.sort_by(|a, b| title_cmp(a, b));
    assert_eq!(titles, ["a", "Ä", "b", "B", "item 10", "item 9"]);
}
