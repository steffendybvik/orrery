#!/usr/bin/env node
// `pnpm orrery:claim [--name "Your Name"] [--replace]`, or in the container `node /app/server/claim.mjs`: claims this server
// for whoever has a shell on it (ORR-664), and prints the owner a person key, once. It writes to the database directly, so
// nothing on the network can race for it. On a server already claimed it refuses, unless `--replace`, which revokes the
// owner's person keys first, for someone who has lost theirs. `--move-issuer <old> <new>` moves the logins to the same
// provider's new address instead (ORR-706), printing no key. Plain Node, as the image has no build tools.
import {createHash, randomBytes} from 'node:crypto'
import {existsSync, readFileSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {fileURLToPath} from 'node:url'

const args = process.argv.slice(2)
const replace = args.includes('--replace')
const given = args.includes('--name') ? args[args.indexOf('--name') + 1]?.trim() : undefined

/** As the server's `actorId`, which test/claim.test.ts holds this to. */
export const idOf = name => name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')

const here = dirname(fileURLToPath(import.meta.url))
/** Where the server's database is: NUXT_DATABASE, the repo's own by default, or where App settings moved it to. */
function database() {
    const setting = process.env.NUXT_DATABASE || join(here, '../../.data/orrery.db')
    if (/^postgres(ql)?:/.test(setting)) return setting
    const file = resolve(setting)
    const moved = `${file}.moved.json`
    return existsSync(moved) ? JSON.parse(readFileSync(moved, 'utf8')).database ?? file : file
}

async function open(where) {
    if (/^postgres(ql)?:/.test(where)) {
        const {default: pg} = await import('pg')
        const client = new pg.Client({connectionString: where})
        await client.connect()
        const numbered = sql => sql.replace(/\?/g, (() => {
            let i = 0
            return () => `$${++i}`
        })())
        return {
            get: async (sql, ...values) => (await client.query(numbered(sql), values)).rows[0],
            run: (sql, ...values) => client.query(numbered(sql), values),
            begin: () => client.query('BEGIN'),
            commit: () => client.query('COMMIT'),
            close: () => client.end(),
        }
    }
    if (!existsSync(where)) throw new Error(`There's no database at ${where}: start orrery once first`)
    const db = new DatabaseSync(where)
    db.exec('PRAGMA busy_timeout = 5000')
    return {
        get: async (sql, ...values) => db.prepare(sql).get(...values),
        run: async (sql, ...values) => db.prepare(sql).run(...values),
        begin: async () => db.exec('BEGIN IMMEDIATE'),
        commit: async () => db.exec('COMMIT'),
        close: async () => db.close(),
    }
}

/** Moves the logins of a provider whose address changed, so nobody needs a new invite. Only the same provider keeps the
 * same subjects: on another, a subject could be someone else's. */
async function moveIssuer(db, [old, to]) {
    const from = old?.replace(/\/+$/, '')
    const target = to?.replace(/\/+$/, '')
    if (!from || !target || from.startsWith('--') || target.startsWith('--')) throw new Error('Give both addresses: --move-issuer <old issuer> <new issuer>')
    await db.begin()
    const {n} = await db.get('SELECT count(*) AS n FROM identities WHERE issuer = ?', from)
    if (!Number(n)) throw new Error(`No logins are from ${from}, so nothing moved. Check the old address: it's what ORRERY_OIDC_ISSUER was set to`)
    if (await db.get('SELECT 1 AS yes FROM identities a JOIN identities b ON b.subject = a.subject WHERE a.issuer = ? AND b.issuer = ?', from, target)) {
        throw new Error(`Someone has already logged in through ${target} with an account from ${from}, so nothing moved`)
    }
    await db.run('UPDATE identities SET issuer = ? WHERE issuer = ?', target, from)
    await db.commit()
    await db.close()
    console.log(`Moved ${n} login${Number(n) === 1 ? '' : 's'} from ${from} to ${target}. Set ORRERY_OIDC_ISSUER to ${target} and restart orrery.`)
}

async function main() {
    const db = await open(database())
    if (args.includes('--move-issuer')) {
        if (!await db.get("SELECT 1 AS yes FROM information_schema.tables WHERE table_name = 'identities'").catch(() => db.get("SELECT 1 AS yes FROM sqlite_master WHERE name = 'identities'"))) {
            throw new Error('This database is from before logins: start this version of orrery once first')
        }
        return await moveIssuer(db, args.slice(args.indexOf('--move-issuer') + 1))
    }
    if (!await db.get("SELECT 1 AS yes FROM information_schema.tables WHERE table_name = 'keys'").catch(() => db.get("SELECT 1 AS yes FROM sqlite_master WHERE name = 'keys'"))) {
        throw new Error('This database is from before keys: start this version of orrery once first')
    }
    const now = new Date().toISOString()
    await db.begin()
    let owner = await db.get("SELECT id, name FROM people WHERE role = 'owner'")
    if (owner && await db.get("SELECT 1 AS yes FROM keys WHERE person = ? AND kind = 'person' AND revoked_at IS NULL", owner.id)) {
        if (!replace) throw new Error(`This server is claimed: ${owner.name} has a person key. --replace revokes it and prints a new one`)
        await db.run("UPDATE keys SET revoked_at = ? WHERE person = ? AND kind = 'person' AND revoked_at IS NULL", now, owner.id)
    }
    if (!owner) {
        const id = given ? idOf(given) : ''
        if (!id) throw new Error('This server has no owner yet: give your name with --name "Your Name"')
        if (['owner', 'agent', 'claude', 'orrery'].includes(id)) throw new Error(`"${id}" is what agents or orrery go by; pick another name`)
        await db.run("INSERT INTO people (id, name, role, created_at) VALUES (?, ?, 'owner', ?)", id, given, now)
        owner = {id, name: given}
    }
    const key = `orrery_person_${randomBytes(32).toString('base64url')}`
    await db.run("INSERT INTO keys (id, person, kind, name, hash, created_at) VALUES (?, ?, 'person', 'orrery:claim', ?, ?)",
        randomBytes(6).toString('hex'), owner.id, createHash('sha256').update(key).digest('hex'), now)
    await db.commit()
    await db.close()
    console.log(`This server is ${owner.name}'s. Your person key, shown this once: sign in with it on the page, and keep it safe.\n\n${key}\n`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    main().catch(error => {
        console.error(error instanceof Error ? error.message : error)
        process.exit(1)
    })
}
