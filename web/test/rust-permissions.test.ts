// The Rust API's copy of the permissions table (ORR-1059, api/permissions.json): what api/src/access/rails.rs holds a
// write to, the chat's, an untrusted session's and a member's columns, without the Nuxt middleware in front, and what
// it answers `GET /api/permissions` with (ORR-1086), whole, as the route here did. The table is still written in
// shared/permissions.ts. Then, to port a change:
//
//   ORRERY_WRITE_PERMISSIONS=1 pnpm --dir web exec vitest run --project unit test/rust-permissions.test.ts
//
// which writes the file. The test fails until it matches.
import {existsSync, readFileSync, writeFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'
import {PERMISSION_LEVELS, PERMISSIONS, SESSION_KINDS} from '#shared/permissions'

const FILE = fileURLToPath(new URL('../../api/permissions.json', import.meta.url))

/** The file as the table is now: `GET /api/permissions`'s reply, `{levels, kinds, permissions}`, a row a line. */
function expected(): string {
    const head = JSON.stringify({levels: PERMISSION_LEVELS, kinds: SESSION_KINDS}).slice(0, -1)
    return `${head},"permissions":[\n${PERMISSIONS.map(row => JSON.stringify(row)).join(',\n')}\n]}\n`
}

describe('the Rust API\'s permissions table', () => {
    it('is shared/permissions.ts as it is now', () => {
        if (process.env.ORRERY_WRITE_PERMISSIONS === '1') writeFileSync(FILE, expected())
        expect(existsSync(FILE), 'run with ORRERY_WRITE_PERMISSIONS=1 to write api/permissions.json').toBe(true)
        expect(readFileSync(FILE, 'utf8'), 'run with ORRERY_WRITE_PERMISSIONS=1 to write api/permissions.json').toBe(expected())
        expect(JSON.parse(readFileSync(FILE, 'utf8'))).toEqual({levels: PERMISSION_LEVELS, kinds: SESSION_KINDS, permissions: PERMISSIONS})
    })
})
