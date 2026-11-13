use super::*;

const GUIDE: &str = "# Using\n\nHow it works.\n\n## Issues\n\nThey hold the work.\n\n## Pages\n\nWhat each page does.\n\n| Page | What |\n|---|---|\n| **Board** (the start) | columns |\n| Docs | the project's docs |\n";

#[test]
fn the_contents_name_each_section_and_its_tables_rows() {
    let said = contents(GUIDE);
    assert!(said.starts_with("# Using\n\nHow it works.\n\n## Contents"));
    assert!(said.ends_with("- Issues\n- Pages: Board, Docs"));
}

#[test]
fn a_section_is_given_whole_and_a_row_by_its_name() {
    assert_eq!(section(GUIDE, " issues "), "## Issues\n\nThey hold the work.");
    assert_eq!(section(GUIDE, "board"), "## Pages\n\n| Page | What |\n|---|---|\n| **Board** (the start) | columns |");
    assert_eq!(section(GUIDE, "Iss"), "## Issues\n\nThey hold the work.");
}

#[test]
fn nothing_found_says_so_with_the_contents() {
    assert!(section(GUIDE, "nowhere").starts_with("No section or page called \"nowhere\" in the guide.\n\n# Using"));
}

#[test]
fn the_built_in_guide_has_sections() {
    assert!(contents(USING).contains("## Contents"));
}
