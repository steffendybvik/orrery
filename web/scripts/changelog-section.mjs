// `node web/scripts/changelog-section.mjs <version>`: a version's section of CHANGELOG.md, without its heading and with
// each entry on one line, for its GitHub release (ORR-742). It fails when there's none, so a release can't go out without
// its notes.
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'

/** A line that starts something of its own, rather than carrying on the text above it. */
const STARTS_BLOCK = /^\s*([-*+] |\d+\. |#|>|\||```)/

/** Joins the lines Markdown wraps in the file, as GitHub's release page would show those breaks. Code stays as it is. */
function unwrap(lines) {
    const out = []
    let code = false
    for (const line of lines) {
        const fence = line.trimStart().startsWith('```')
        const carriesOn = !code && !fence && line.trim() && !STARTS_BLOCK.test(line)
            && out.length && out.at(-1).trim() && !out.at(-1).startsWith('#')
        if (carriesOn) out[out.length - 1] += ` ${line.trim()}`
        else out.push(line)
        if (fence) code = !code
    }
    return out
}

/** The section for exactly this version, or null when there's none or it's empty: 1.0.0-rc.1 doesn't find 1.0.0-rc.15. */
export function changelogSection(changelog, version) {
    const lines = changelog.split('\n')
    const start = lines.findIndex(line => line === `## ${version}` || line.startsWith(`## ${version} (`))
    if (start < 0) return null
    const rest = lines.slice(start + 1)
    const end = rest.findIndex(line => line.startsWith('## '))
    const section = unwrap(end < 0 ? rest : rest.slice(0, end)).join('\n').trim()
    return section || null
}

function main(version) {
    if (!version) {
        console.error('Usage: node web/scripts/changelog-section.mjs <version>')
        process.exit(1)
    }
    const section = changelogSection(readFileSync(join(import.meta.dirname, '..', '..', 'CHANGELOG.md'), 'utf8'), version)
    if (!section) {
        console.error(`CHANGELOG.md has no section for ${version}: add "## ${version} (<day>)" with its changes (see Releasing).`)
        process.exit(1)
    }
    console.log(section)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv[2])
