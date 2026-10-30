import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'
// @ts-expect-error A plain script, with no types.
import {changelogSection} from '../scripts/changelog-section.mjs'

const CHANGELOG = `# Changelog

Some words about it.

## 1.0.0-rc.15 (2026-10-30)

### Features

- **A long one:** that wraps
  onto a second line
  and a third.
- **A short one:** that doesn't.

### Fixes

- **One with a list:**
  - a nested item that
    wraps too

\`\`\`sh
docker compose up
  --build
\`\`\`

## 1.0.0-rc.1 (2026-10-25)

- **The first.**

## 1.0.0-rc.0 (2026-10-24)

## 0.9.0

- **No date.**
`

describe('a version\'s section of the changelog', () => {
    it('leaves out its heading and the next version\'s, with each entry on one line (ORR-742)', () => {
        expect(changelogSection(CHANGELOG, '1.0.0-rc.15')).toBe(`### Features

- **A long one:** that wraps onto a second line and a third.
- **A short one:** that doesn't.

### Fixes

- **One with a list:**
  - a nested item that wraps too

\`\`\`sh
docker compose up
  --build
\`\`\``)
    })

    it('finds exactly that version, not one it\'s the start of', () => {
        expect(changelogSection(CHANGELOG, '1.0.0-rc.1')).toBe('- **The first.**')
        expect(changelogSection(CHANGELOG, '1.0.0-rc')).toBeNull()
        expect(changelogSection(CHANGELOG, '1.0.0-rc.16')).toBeNull()
    })

    it('reads the last section, and one with no date', () => {
        expect(changelogSection(CHANGELOG, '0.9.0')).toBe('- **No date.**')
    })

    it('counts a section with nothing in it as none', () => {
        expect(changelogSection(CHANGELOG, '1.0.0-rc.0')).toBeNull()
    })

    it('reads every version in the real changelog, leaving no wrapped line in a section', () => {
        const changelog = readFileSync(join(__dirname, '..', '..', 'CHANGELOG.md'), 'utf8')
        const versions = [...changelog.matchAll(/^## (\S+)/gm)].map(m => m[1]!)
        expect(versions.length).toBeGreaterThan(10)
        for (const version of versions) {
            const section: string = changelogSection(changelog, version)
            expect(section, version).toBeTruthy()
            let code = false
            for (const line of section.split('\n')) {
                if (line.trimStart().startsWith('```')) code = !code
                else if (!code && line.startsWith('  ')) expect(line, version).toMatch(/^\s+([-*+] |\d+\. )/)
            }
        }
    })
})
