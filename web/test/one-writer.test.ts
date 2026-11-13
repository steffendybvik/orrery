// One writer per table (ORR-1010): every table the Rust API writes, read off its SQL, has a line in table-writers.ts
// saying it's the API's alone once routed, or what the Nuxt server still writes there. A new table the API starts
// writing fails here until someone says which, and so does a line for a table it no longer writes.
import {mkdtempSync, readdirSync, readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, relative} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'
import {migrate} from '../server/utils/db'
import {MIGRATIONS} from '../server/utils/migrations/sqlite'
import {DYNAMIC, WRITERS} from './table-writers'

const SRC = fileURLToPath(new URL('../../api/src', import.meta.url))
/** The API's own code: not its tests, nor the migrations, which the Node app runs (rust-migrations.test.ts), nor the
 * copy into another database (copy.rs), which writes that one, not the one open. */
const NOT_SCANNED = /(_tests|\/testing|\/migrate|\/steps|\/copy)\.rs$/
const WRITE = /\b(?:INSERT(?:\s+OR\s+[A-Z]+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+"?([a-z_]+|\{[^}]*\})/g

/** Each table the API's SQL writes, with the files that write it; a `{}` table is listed under its file in DYNAMIC. */
function written(): {tables: Map<string, Set<string>>, dynamic: string[]} {
    const walk = (dir: string): string[] => readdirSync(dir, {withFileTypes: true}).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)])
    const tables = new Map<string, Set<string>>()
    const dynamic = new Set<string>()
    for (const path of walk(SRC).filter(path => path.endsWith('.rs') && !NOT_SCANNED.test(path))) {
        const file = relative(SRC, path)
        for (const [, table = ''] of readFileSync(path, 'utf8').matchAll(WRITE)) {
            for (const name of table.startsWith('{') ? (dynamic.add(file), DYNAMIC[file] ?? []) : [table]) {
                if (!tables.has(name)) tables.set(name, new Set())
                tables.get(name)!.add(file)
            }
        }
    }
    return {tables, dynamic: [...dynamic].sort()}
}

describe('one writer per table', () => {
    const {tables, dynamic} = written()

    it('reads the tables off the SQL, so a broken pattern fails rather than passing on nothing', () => {
        expect(tables.size).toBeGreaterThan(20)
        expect(tables.get('docs')).toContain('board/docs.rs')
    })

    it('names the tables of every write whose table the code picks', () => {
        expect(dynamic, 'files writing a `{}` table: list them in DYNAMIC').toEqual(Object.keys(DYNAMIC).sort())
    })

    it('has a line for every table the Rust API writes', () => {
        expect([...tables.keys()].filter(table => !WRITERS[table]).sort(), 'tables without a line in table-writers.ts').toEqual([])
    })

    it('has no line for a table the Rust API no longer writes', () => {
        expect(Object.keys(WRITERS).filter(table => !tables.has(table)), 'stale lines in table-writers.ts').toEqual([])
    })

    it('says why of each, and names a real issue where it names one', () => {
        for (const [table, writer] of Object.entries(WRITERS)) {
            expect('alone' in writer ? writer.alone : writer.nuxt, table).not.toBe('')
            if ('issue' in writer && writer.issue) expect(writer.issue, table).toMatch(/^ORR-\d+$/)
        }
    })

    it('names only tables the migrations make', () => {
        const path = join(mkdtempSync(join(tmpdir(), 'orrery-writers-')), 'orrery.db')
        const db = new DatabaseSync(path)
        migrate(db, path, MIGRATIONS.length)
        const made = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {name: string}[]).map(row => row.name))
        db.close()
        expect(Object.keys(WRITERS).filter(table => !made.has(table)), 'tables no migration makes').toEqual([])
    })
})
