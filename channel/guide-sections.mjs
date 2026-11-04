// The `guide` tool's answer cut to size (ORR-848): docs/using.md whole is about 10k tokens, so the tool hands a session
// its contents, and one section, or one row of its Pages table, when asked. Done here rather than by the server, so an
// orrery that serves the whole file still gets the short answer.

const strip = cell => cell.replace(/\*\*/g, '').replace(/\s*\(.*$/, '').trim()
const norm = text => text.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim()

/** The guide split into its opening, its `##` sections and the rows of any table in them, each row named by its first cell. */
export function guideParts(markdown) {
    const [opening, ...chunks] = markdown.split(/^(?=## )/m)
    const sections = chunks.map(chunk => {
        const [heading, ...body] = chunk.split('\n')
        const lines = body.join('\n').trimEnd().split('\n')
        const tableAt = lines.findIndex(l => l.startsWith('|'))
        const table = tableAt < 0 ? [] : lines.slice(tableAt).filter(l => l.startsWith('|'))
        const rows = table.slice(2).map(line => ({name: strip(line.split('|')[1] ?? ''), line}))
        return {name: heading.replace(/^## /, '').trim(), text: chunk.trimEnd(), lead: lines.slice(0, Math.max(tableAt, 0)).join('\n').trim(), head: table.slice(0, 2), rows}
    })
    return {opening: opening.trimEnd(), sections}
}

/** The contents: the opening, then each section, with the names of its table's rows when it has one. */
export function guideContents(markdown) {
    const {opening, sections} = guideParts(markdown)
    const names = rows => [...new Set(rows.map(r => r.name))].join(', ')
    return `${opening}

## Contents

Call guide with a section, or a page from Pages, for its text (one per call):
${sections.map(s => `- ${s.name}${s.rows.length ? `: ${names(s.rows)}` : ''}`).join('\n')}`
}

/** One section, or the rows of a table whose first cell is named so; the contents, saying so, when nothing matches. */
export function guideSection(markdown, section) {
    const want = norm(section)
    const {sections} = guideParts(markdown)
    const rowsOf = test => sections.flatMap(s => s.rows.filter(r => r.name && test(norm(r.name))).map(r => ({s, r})))
    const asRows = found => {
        const s = found[0].s
        return [`## ${s.name}`, '', ...s.head, ...found.map(f => f.r.line)].join('\n')
    }
    const whole = sections.find(s => norm(s.name) === want)
    // A section that's one long table (Pages) gives its lead and the rows' names: each row is asked for on its own.
    if (whole) return whole.rows.length && whole.text.length > 6_000
        ? [`## ${whole.name}`, whole.lead, `Call guide with one of these for its row: ${[...new Set(whole.rows.map(r => r.name))].join(', ')}`].filter(Boolean).join('\n\n')
        : whole.text
    for (const test of [name => name === want, name => name.includes(want) || (name.length > 3 && want.includes(name))]) {
        const found = rowsOf(test)
        if (found.length) return asRows(found.filter(f => f.s === found[0].s))
    }
    const partly = sections.find(s => norm(s.name).includes(want))
    if (partly) return guideSection(markdown, partly.name)
    return `No section or page called "${section}" in the guide.\n\n${guideContents(markdown)}`
}
