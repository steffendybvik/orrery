// The Rust API's copy of the permissions table (ORR-1059, api/permissions.json): what api/src/access/rails.rs holds a
// write to, the chat's, an untrusted session's and a member's columns, without the Nuxt middleware in front. The table
// is still written in shared/permissions.ts. Then, to port a change:
//
//   ORRERY_WRITE_PERMISSIONS=1 pnpm --dir web exec vitest run --project unit test/rust-permissions.test.ts
//
// which writes the file. The test fails until it matches.
import {existsSync, readFileSync, writeFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'
import {PERMISSIONS} from '#shared/permissions'
import type {PermissionCell} from '#shared/permissions'

const FILE = fileURLToPath(new URL('../../api/permissions.json', import.meta.url))

/** What the rails read of a cell: its level, the routes it narrows to and its check. Notes are the page's. */
function cell({level, routes, check}: PermissionCell): PermissionCell {
    const kept: PermissionCell = {level}
    if (routes) kept.routes = routes
    if (check) kept.check = check
    return kept
}

/** The file as the table is now, a row a line. */
function expected(): string {
    const rows = PERMISSIONS.map(row => JSON.stringify({
        id: row.id,
        action: row.action,
        why: row.why,
        routes: row.routes,
        chat: cell(row.chat),
        untrusted: cell(row.untrusted),
        member: cell(row.member),
        ...row.unnamed ? {unnamed: row.unnamed} : {},
    }))
    return `[\n${rows.join(',\n')}\n]\n`
}

describe('the Rust API\'s permissions table', () => {
    it('is shared/permissions.ts as it is now', () => {
        if (process.env.ORRERY_WRITE_PERMISSIONS === '1') writeFileSync(FILE, expected())
        expect(existsSync(FILE), 'run with ORRERY_WRITE_PERMISSIONS=1 to write api/permissions.json').toBe(true)
        expect(readFileSync(FILE, 'utf8'), 'run with ORRERY_WRITE_PERMISSIONS=1 to write api/permissions.json').toBe(expected())
    })
})
