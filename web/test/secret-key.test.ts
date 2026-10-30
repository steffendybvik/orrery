import {existsSync, mkdtempSync, readFileSync, statSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'
import {secretKey, secretKeyFile} from '../server/utils/secret-key'

// Secrets work out of the box (ORR-614): with no ORRERY_SECRET_KEY, orrery makes a key and keeps it beside the database.
describe("the secrets' key", () => {
    const dir = () => mkdtempSync(join(tmpdir(), 'orrery-key-'))

    it('is made on the first start, readable by its owner alone, and read back on the next', () => {
        const file = secretKeyFile(join(dir(), 'orrery.db'), false)!
        const made = secretKey('', file)
        expect(Buffer.from(made, 'base64')).toHaveLength(32)
        expect(statSync(file).mode & 0o777).toBe(0o600)
        expect(secretKey('', file)).toBe(made)
    })

    it("is the owner's own when they set one, and then no file is made", () => {
        const file = secretKeyFile(join(dir(), 'orrery.db'), false)!
        expect(secretKey('their key', file)).toBe('their key')
        expect(existsSync(file)).toBe(false)
    })

    it("keeps one that's there, rather than writing over it", () => {
        const file = join(dir(), 'orrery.key')
        writeFileSync(file, 'kept\n')
        expect(secretKey('', file)).toBe('kept')
        expect(readFileSync(file, 'utf8')).toBe('kept\n')
    })

    it("sits in the SQLite file's folder, so /data in Docker on either database, and nowhere for Postgres outside it", () => {
        expect(secretKeyFile('/data/orrery.db', true)).toBe('/data/orrery.key')
        expect(secretKeyFile('/srv/orrery/other.db', false)).toBe('/srv/orrery/orrery.key')
        expect(secretKeyFile('postgres://orrery@db/orrery', true)).toBe('/data/orrery.key')
        expect(secretKeyFile('postgres://orrery@db/orrery', false)).toBeNull()
        expect(secretKey('', null)).toBe('')
    })

    it("is empty when it can't be kept, so secrets still say they need one", () => {
        const file = join(dir(), 'orrery.db')
        writeFileSync(file, '')
        expect(secretKey('', join(file, 'nested', 'orrery.key'))).toBe('')
    })
})
