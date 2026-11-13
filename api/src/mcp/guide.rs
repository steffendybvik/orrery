// The `guide` tool's answer (ORR-1098), cut to size as channel/guide-sections.mjs cuts it (ORR-848): docs/using.md's
// contents, or the one section, or row of its Pages table, asked for. The guide is built in, so it's what this orrery does.

pub(crate) const USING: &str = include_str!("../../../docs/using.md");

struct Row {
    name: String,
    line: String,
}

struct Section {
    name: String,
    text: String,
    lead: String,
    head: Vec<String>,
    rows: Vec<Row>,
}

/// A table cell's name: without bold, and without anything from a `(` on.
fn strip(cell: &str) -> String {
    let cell = cell.replace("**", "");
    let cut = match cell.find('(') {
        Some(at) => cell[..at].trim_end(),
        None => cell.as_str(),
    };
    cut.trim().to_string()
}

fn norm(text: &str) -> String {
    text.to_lowercase().replace('’', "'").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// How long JavaScript says a text is, as the channel's limits count it.
fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The guide split into its opening, its `##` sections and the rows of any table in them, each named by its first cell.
fn parts(markdown: &str) -> (String, Vec<Section>) {
    let mut chunks: Vec<String> = Vec::new();
    for line in markdown.split_inclusive('\n') {
        if line.starts_with("## ") || chunks.is_empty() {
            chunks.push(String::new());
        }
        chunks.last_mut().expect("a chunk").push_str(line);
    }
    // As JavaScript's split, a guide that starts with a section has no opening apart from it.
    let opening = if markdown.starts_with("## ") { chunks[0].clone() } else { chunks.remove(0) };
    let sections = chunks
        .iter()
        .map(|chunk| {
            let (heading, body) = chunk.split_once('\n').unwrap_or((chunk.as_str(), ""));
            let lines: Vec<&str> = body.trim_end().split('\n').collect();
            let table_at = lines.iter().position(|l| l.starts_with('|'));
            let table: Vec<&str> = table_at.map(|at| lines[at..].iter().copied().filter(|l| l.starts_with('|')).collect()).unwrap_or_default();
            let rows = table.iter().skip(2).map(|line| Row { name: strip(line.split('|').nth(1).unwrap_or("")), line: line.to_string() }).collect();
            Section {
                name: heading.trim_start_matches("## ").trim().to_string(),
                text: chunk.trim_end().to_string(),
                lead: lines[..table_at.unwrap_or(0)].join("\n").trim().to_string(),
                head: table.iter().take(2).map(|l| l.to_string()).collect(),
                rows,
            }
        })
        .collect();
    (opening.trim_end().to_string(), sections)
}

fn names(rows: &[Row]) -> String {
    let mut seen: Vec<&str> = Vec::new();
    for row in rows {
        if !seen.contains(&row.name.as_str()) {
            seen.push(&row.name);
        }
    }
    seen.join(", ")
}

/// The contents: the opening, then each section, with the names of its table's rows when it has one.
pub(crate) fn contents(markdown: &str) -> String {
    let (opening, sections) = parts(markdown);
    let listed: Vec<String> =
        sections.iter().map(|s| if s.rows.is_empty() { format!("- {}", s.name) } else { format!("- {}: {}", s.name, names(&s.rows)) }).collect();
    format!("{opening}\n\n## Contents\n\nCall guide with a section, or a page from Pages, for its text (one per call):\n{}", listed.join("\n"))
}

/// One section, or the rows of a table whose first cell is named so; the contents, saying so, when nothing matches.
pub(crate) fn section(markdown: &str, asked: &str) -> String {
    let want = norm(asked);
    let (_, sections) = parts(markdown);
    if let Some(whole) = sections.iter().find(|s| norm(&s.name) == want) {
        // A section that's one long table (Pages) gives its lead and the rows' names: each row is asked for on its own.
        if !whole.rows.is_empty() && js_len(&whole.text) > 6_000 {
            let call = format!("Call guide with one of these for its row: {}", names(&whole.rows));
            return [format!("## {}", whole.name), whole.lead.clone(), call].into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join("\n\n");
        }
        return whole.text.clone();
    }
    let exact = |name: &str| name == want;
    let partly = |name: &str| name.contains(&want) || (js_len(name) > 3 && want.contains(name));
    for test in [&exact as &dyn Fn(&str) -> bool, &partly] {
        let found: Vec<(usize, &Row)> =
            sections.iter().enumerate().flat_map(|(i, s)| s.rows.iter().filter(|r| !r.name.is_empty() && test(&norm(&r.name))).map(move |r| (i, r))).collect();
        if let Some(&(first, _)) = found.first() {
            let s = &sections[first];
            let mut lines = vec![format!("## {}", s.name), String::new()];
            lines.extend(s.head.iter().cloned());
            lines.extend(found.iter().filter(|(i, _)| *i == first).map(|(_, r)| r.line.clone()));
            return lines.join("\n");
        }
    }
    if let Some(partly) = sections.iter().find(|s| norm(&s.name).contains(&want)) {
        return section(markdown, &partly.name.clone());
    }
    format!("No section or page called \"{asked}\" in the guide.\n\n{}", contents(markdown))
}

#[cfg(test)]
#[path = "guide_tests.rs"]
mod tests;
