// The Rust API's copy of the listed features (ORR-1089, api/features.json): what api/src/work/usage.rs lists in App
// settings' Usage before their first use, and names. The list is still written in shared/usage.ts. Then, to port a
// change:
//
//   ORRERY_WRITE_FEATURES=1 pnpm --dir web exec vitest run --project unit test/rust-features.test.ts
//
// which writes the file. The test fails until it matches.
import {existsSync, readFileSync, writeFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'
import {FEATURE_NAME, FEATURES} from '#shared/usage'

const FILE = fileURLToPath(new URL('../../api/features.json', import.meta.url))
const RUST = fileURLToPath(new URL('../../api/src/work/usage.rs', import.meta.url))

/** The file as the list is now, a feature a line. */
function expected(): string {
    return `{\n${Object.entries(FEATURES).map(([feature, label]) => `${JSON.stringify(feature)}: ${JSON.stringify(label)}`).join(',\n')}\n}\n`
}

describe('the Rust API\'s listed features', () => {
    it('is shared/usage.ts as it is now', () => {
        if (process.env.ORRERY_WRITE_FEATURES === '1') writeFileSync(FILE, expected())
        expect(existsSync(FILE), 'run with ORRERY_WRITE_FEATURES=1 to write api/features.json').toBe(true)
        expect(readFileSync(FILE, 'utf8'), 'run with ORRERY_WRITE_FEATURES=1 to write api/features.json').toBe(expected())
    })

    it('takes the same feature names', () => {
        expect(readFileSync(RUST, 'utf8')).toContain(`Regex::new(r"${FEATURE_NAME.source}")`)
    })
})
