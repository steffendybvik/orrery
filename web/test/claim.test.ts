import {execFile} from 'node:child_process'
import {mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import type {DatabaseSync} from 'node:sqlite'
import {fileURLToPath} from 'node:url'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {idOf} from '../scripts/claim.mjs'
import {SqliteDb} from '../server/utils/database'
import {openDb} from '../server/utils/db'
import {MIGRATIONS} from '../server/utils/migrations/sqlite'
import {actorId, Store} from '../server/utils/store'

// `pnpm orrery:claim` (ORR-664, ORR-698), the one way into a server with login on and no provider. It writes to the
// database with its own SQL, so it's run for real here, on a file the store made, and the store has to accept what it wrote.
const script = fileURLToPath(new URL('../scripts/claim.mjs', import.meta.url))
const KEY = /orrery_person_[\w-]+/

let dir: string
let path: string
let opened: DatabaseSync
let store: Store

const open = (file: string) => {
    opened = openDb(file)
    return new Store(new SqliteDb(opened))
}

/** Runs it as a shell on the server would, against `database`. */
function claim(args: string[] = [], database = path): Promise<{code: number, out: string, err: string}> {
    return new Promise(done => {
        execFile(process.execPath, [script, ...args], {env: {...process.env, NUXT_DATABASE: database}}, (error, out, err) => {
            done({code: error ? Number(error.code) : 0, out, err})
        })
    })
}

/** The person key it printed. */
async function claimed(args: string[] = [], database = path): Promise<string> {
    const {code, out, err} = await claim(args, database)
    expect(err.replace(/.*ExperimentalWarning.*\n?|.*--trace-warnings.*\n?/g, '')).toBe('')
    expect(code).toBe(0)
    return KEY.exec(out)![0]
}

const owner = () => opened.prepare("SELECT id, name FROM people WHERE role = 'owner'").get()
const keyRows = () => opened.prepare('SELECT id, person, kind, name, hash, revoked_at FROM keys ORDER BY id').all()

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orrery-claim-'))
    path = join(dir, 'orrery.db')
    store = open(path)
})

afterEach(() => opened.close())

describe('on an unclaimed server', () => {
    it('prints the owner a person key the store accepts', async () => {
        await store.nameOwner({name: 'Skoll'})
        const key = await claimed()
        expect(await store.keyHolder(key)).toMatchObject({person: 'skoll', kind: 'person'})
        expect(keyRows()).toMatchObject([{person: 'skoll', kind: 'person', name: 'orrery:claim', revoked_at: null}])
        // Only its hash is kept.
        expect(JSON.stringify(keyRows())).not.toContain(key)
    })

    it('says whose it is and that the key shows once', async () => {
        await store.nameOwner({name: 'Skoll'})
        const {out} = await claim()
        expect(out).toContain("This server is Skoll's")
        expect(out).toContain('shown this once')
    })

    it('makes the owner from --name when there is none', async () => {
        const key = await claimed(['--name', 'Sköll Fenrisson'])
        expect(owner()).toEqual({id: 'skoll_fenrisson', name: 'Sköll Fenrisson'})
        expect(await store.keyHolder(key)).toMatchObject({person: 'skoll_fenrisson'})
    })

    it('needs a name when there is no owner', async () => {
        for (const args of [[], ['--name'], ['--name', '---']]) {
            const {code, out, err} = await claim(args)
            expect(code).toBe(1)
            expect(err).toContain('give your name with --name')
            expect(out).not.toMatch(KEY)
        }
        expect(owner()).toBeUndefined()
    })

    it('refuses a name agents or orrery go by', async () => {
        for (const name of ['owner', 'Agent', 'CLAUDE', 'orrery']) {
            const {code, err} = await claim(['--name', name])
            expect(code).toBe(1)
            expect(err).toContain('pick another name')
        }
        expect(owner()).toBeUndefined()
        expect(keyRows()).toEqual([])
    })

    it('gives the owner a key again once theirs is revoked, with no --replace', async () => {
        await store.nameOwner({name: 'Skoll'})
        const first = await claimed()
        await store.revokeKey((await store.keys('skoll'))[0]!.id)
        const second = await claimed()
        expect(await store.keyHolder(first)).toBeFalsy()
        expect(await store.keyHolder(second)).toMatchObject({person: 'skoll'})
    })
})

describe('--move-issuer', () => {
    const OLD = 'https://old.example'
    const NEW = 'https://new.example'
    const seed = (issuer: string, subject: string, person: string) => opened.prepare('INSERT INTO identities (issuer, subject, person) VALUES (?, ?, ?)').run(issuer, subject, person)
    const rows = () => opened.prepare('SELECT issuer, subject, person FROM identities ORDER BY subject').all()

    beforeEach(async () => {
        await store.nameOwner({name: 'Skoll'})
        await store.addPerson({name: 'Hati'})
    })

    it('moves the logins, which the store then finds at the new address, and prints no key', async () => {
        seed(OLD, 'a', 'skoll')
        seed(OLD, 'b', 'hati')
        seed('https://other.example', 'c', 'hati')
        const {code, out} = await claim(['--move-issuer', `${OLD}/`, `${NEW}/`])
        expect(code).toBe(0)
        expect(out).toContain('Moved 2 logins')
        expect(out).toContain(`ORRERY_OIDC_ISSUER to ${NEW}`)
        expect(out).not.toMatch(KEY)
        expect(rows()).toEqual([{issuer: NEW, subject: 'a', person: 'skoll'}, {issuer: NEW, subject: 'b', person: 'hati'}, {issuer: 'https://other.example', subject: 'c', person: 'hati'}])
        expect(keyRows()).toEqual([])
        expect(await store.identity(NEW, 'b')).toBe('hati')
        expect(await store.identity(OLD, 'b')).toBeUndefined()
    })

    it('leaves keys working', async () => {
        const key = await claimed()
        seed(OLD, 'a', 'skoll')
        expect((await claim(['--move-issuer', OLD, NEW])).code).toBe(0)
        expect(await store.keyHolder(key)).toMatchObject({person: 'skoll'})
    })

    it('refuses a mistyped address, a missing one and a login already at the new one, changing nothing', async () => {
        seed(OLD, 'a', 'skoll')
        seed(NEW, 'a', 'hati')
        const before = rows()
        for (const [args, says] of [
            [['--move-issuer', 'https://typo.example', NEW], 'No logins are from'],
            [['--move-issuer', OLD], 'Give both addresses'],
            [['--move-issuer'], 'Give both addresses'],
            [['--move-issuer', OLD, NEW], 'already logged in'],
        ] as const) {
            const {code, err} = await claim([...args])
            expect(code).toBe(1)
            expect(err).toContain(says)
        }
        expect(rows()).toEqual(before)
    })
})

describe('on a claimed server', () => {
    let first: string

    beforeEach(async () => {
        await store.nameOwner({name: 'Skoll'})
        first = await claimed()
    })

    it('refuses, exits 1 and changes nothing', async () => {
        const before = keyRows()
        const {code, out, err} = await claim()
        expect(code).toBe(1)
        expect(err).toContain('This server is claimed: Skoll has a person key')
        expect(out).not.toMatch(KEY)
        expect(keyRows()).toEqual(before)
        expect(await store.keyHolder(first)).toMatchObject({person: 'skoll'})
    })

    it('leaves the owner as they are when given another --name', async () => {
        expect((await claim(['--name', 'Hati'])).code).toBe(1)
        expect(owner()).toEqual({id: 'skoll', name: 'Skoll'})
    })

    it('--replace revokes the old person key and prints a new one', async () => {
        const second = await claimed(['--replace'])
        expect(second).not.toBe(first)
        expect(await store.keyHolder(first)).toBeFalsy()
        expect(await store.keyHolder(second)).toMatchObject({person: 'skoll', kind: 'person'})
    })

    it('--replace leaves the owner\'s agent keys and everyone else\'s keys working', async () => {
        await store.addPerson({name: 'Hati'})
        const {key: agent} = await store.makeKey('skoll', {kind: 'agent', name: 'laptop'})
        const {key: hati} = await store.makeKey('hati', {kind: 'person', name: 'page'})
        await claimed(['--replace'])
        expect(await store.keyHolder(agent)).toMatchObject({person: 'skoll', kind: 'agent'})
        expect(await store.keyHolder(hati)).toMatchObject({person: 'hati', kind: 'person'})
    })

    it('--replace that fails after revoking keeps the old key, so the owner is never locked out', async () => {
        opened.exec("CREATE TRIGGER no_new_keys BEFORE INSERT ON keys BEGIN SELECT RAISE(ABORT, 'disk full'); END")
        const {code, out} = await claim(['--replace'])
        expect(code).toBe(1)
        expect(out).not.toMatch(KEY)
        expect(await store.keyHolder(first)).toMatchObject({person: 'skoll'})
    })
})

describe('where the database is', () => {
    it('follows a .moved.json to the moved database', async () => {
        const moved = join(dir, 'elsewhere.db')
        const atMoved = openDb(moved)
        const there = new Store(new SqliteDb(atMoved))
        await there.nameOwner({name: 'Hati'})
        await store.nameOwner({name: 'Skoll'})
        writeFileSync(`${path}.moved.json`, JSON.stringify({database: moved}))
        const key = await claimed()
        expect(await there.keyHolder(key)).toMatchObject({person: 'hati'})
        expect(keyRows()).toEqual([])
        atMoved.close()
    })

    it('says to start orrery first on a database from before keys', async () => {
        const old = join(dir, 'old.db')
        const before = MIGRATIONS.findIndex(step => typeof step === 'string' && step.includes('CREATE TABLE keys'))
        openDb(old, before).close()
        const {code, err} = await claim([], old)
        expect(code).toBe(1)
        expect(err).toContain('This database is from before keys: start this version of orrery once first')
    })

    it('says to start orrery first when there is no database yet', async () => {
        const {code, err} = await claim([], join(dir, 'none.db'))
        expect(code).toBe(1)
        expect(err).toContain('start orrery once first')
    })
})

describe('its ids', () => {
    it('are the same as the server makes', () => {
        for (const name of ['Sköll Fenrisson', '  A--b ', 'Ævar Þór']) expect(idOf(name)).toBe(actorId(name))
    })
})
