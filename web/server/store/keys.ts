// Who's who when auth is on (ORR-664): the keys people make, the logins a browser holds, and the invites and identities
// that tie a provider's account to a person. Only hashes are kept, looked up on each request, so revoking works at once.
// Below the projects, above the people.
import {createHash, randomBytes} from 'node:crypto'
import type {KeyKind, KeyRecord, LoginRecord} from '#shared/roadmap'
import {badRequest, conflict, notFound} from '../utils/input'
import {PeopleStore} from './people'
import {actorId, AGENT, stamp} from './schema'

/** A credential once checked: the person behind it, and the kind of key if it was one. */
export interface Holder {
    person: string
    owner: boolean
    kind?: KeyKind
    /** The key's id, when it was one. */
    key?: string
}

type KeyRow = {id: string, person: string, kind: KeyKind, name: string, created_at: string, last_used_at: string | null, revoked_at: string | null}
type LoginRow = {id: string, person: string, name: string | null, created_at: string | null, last_used_at: string | null, expires_at: string}
/** How much of a login's hash names it in the list: enough to tell them apart, nothing a cookie could be made from. */
const LOGIN_REF = 16
const loginOf = ({id, person, name, created_at, last_used_at, expires_at}: LoginRow): LoginRecord =>
    ({id: id.slice(0, LOGIN_REF), person, ...name ? {name} : {}, ...created_at ? {created_at} : {}, ...last_used_at ? {last_used_at} : {}, expires_at})

const keyOf = ({id, person, kind, name, created_at, last_used_at, revoked_at}: KeyRow): KeyRecord =>
    ({id, person, kind, name, created_at, ...last_used_at ? {last_used_at} : {}, ...revoked_at ? {revoked_at} : {}})

const hashOf = (secret: string) => createHash('sha256').update(secret).digest('hex')
const token = () => randomBytes(32).toString('base64url')
const LOGIN_DAYS = 30
const INVITE_DAYS = 7
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString()
/** A key's last use is only for the list, so it's written at most this often. */
const USED_EVERY = 60_000

/** What `GET /api/auth/ways-in` says: whether the owner has a person key, and whether login stays on. */
type WaysIn = {owner_has_key: boolean, stays_on: boolean}

export abstract class KeyStore extends PeopleStore {
    /** The keys of `person`, or everyone's, the newest first; a revoked one stays listed. Never the key itself. */
    async keys(person?: string): Promise<KeyRecord[]> {
        return (await this.all<KeyRow>(`SELECT * FROM keys${person ? ' WHERE person = ?' : ''} ORDER BY created_at DESC, id`, ...person ? [person] : [])).map(keyOf)
    }

    /** Makes a key for `person`: this is the only time its secret is seen. The prefix says its kind, so the channel can
     * refuse a person key before sending it anywhere. */
    async makeKey(person: string, body: {kind?: unknown, name?: unknown}): Promise<KeyRecord & {key: string}> {
        const {kind, name} = body ?? {}
        if (kind !== 'agent' && kind !== 'person') throw badRequest('"kind" is "agent", for a machine\'s sessions, or "person", to sign in to the page')
        const label = String(name ?? '').trim().slice(0, 60)
        if (!label) throw badRequest('"name" says what the key is for, such as the machine it\'s on')
        await this.needsPerson(person)
        const key = `orrery_${kind}_${token()}`
        const id = randomBytes(6).toString('hex')
        const created = stamp()
        await this.run('INSERT INTO keys (id, person, kind, name, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, person, kind, label, hashOf(key), created)
        return {id, person, kind, name: label, created_at: created, key}
    }

    /** Revokes a key, at once, with the logins it started (ORR-786), and its person's logins from before orrery kept
     * which key started one; revoking it again changes nothing. `mine`, when given, is whose it has to be. */
    async revokeKey(id: string, mine?: string): Promise<void> {
        const key = await this.get<KeyRow>('SELECT * FROM keys WHERE id = ?', id)
        if (!key || mine && key.person !== mine) throw notFound(`No key "${id}"`)
        if (key.revoked_at) return
        await this.db.transaction(async () => {
            await this.run('UPDATE keys SET revoked_at = ? WHERE id = ?', stamp(), id)
            await this.run('DELETE FROM logins WHERE by_key = ? OR person = ? AND known = 0', id, key.person)
        })
    }

    /** Who a key is, if it's live and its person is still here. */
    async keyHolder(secret: string): Promise<Holder | undefined> {
        const row = await this.get<{id: string, kind: KeyKind, person: string, role: string, last_used_at: string | null}>(
            `SELECT k.id, k.kind, k.person, p.role, k.last_used_at FROM keys k JOIN people p ON p.id = k.person
             WHERE k.hash = ? AND k.revoked_at IS NULL AND p.removed_at IS NULL`, hashOf(secret))
        if (!row) return undefined
        if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > USED_EVERY) await this.run('UPDATE keys SET last_used_at = ? WHERE id = ?', stamp(), row.id)
        return {person: row.person, owner: row.role === 'owner', kind: row.kind, key: row.id}
    }

    /** Starts a browser's login for `person`: what goes in its cookie. `key` is the id of the key it was started with,
     * so revoking that ends it; none for a provider's. `name` says how it was made, for the list (ORR-838). */
    async startLogin(person: string, key?: string, name?: string): Promise<{secret: string, days: number}> {
        const secret = token()
        const now = stamp()
        await this.run('DELETE FROM logins WHERE expires_at < ?', now)
        await this.run('INSERT INTO logins (id, person, expires_at, by_key, known, name, created_at, last_used_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)',
            hashOf(secret), person, days(LOGIN_DAYS), key ?? null, name ?? null, now, now)
        return {secret, days: LOGIN_DAYS}
    }

    /** Who a login's cookie is, if it hasn't run out and they're still here. */
    async loginHolder(secret: string): Promise<Holder | undefined> {
        const id = hashOf(secret)
        const row = await this.get<{person: string, role: string, last_used_at: string | null}>(
            `SELECT l.person, p.role, l.last_used_at FROM logins l JOIN people p ON p.id = l.person WHERE l.id = ? AND l.expires_at > ? AND p.removed_at IS NULL`, id, stamp())
        if (!row) return undefined
        if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > USED_EVERY) await this.run('UPDATE logins SET last_used_at = ? WHERE id = ?', stamp(), id)
        return {person: row.person, owner: row.role === 'owner'}
    }

    async endLogin(secret: string): Promise<void> {
        await this.run('DELETE FROM logins WHERE id = ?', hashOf(secret))
    }

    /** The live logins of `person`, or everyone's, the latest used first (ORR-838); `secret` is the asking browser's
     * cookie, to mark it. */
    async logins(person?: string, secret?: string): Promise<LoginRecord[]> {
        const rows = await this.all<LoginRow>(
            `SELECT id, person, name, created_at, last_used_at, expires_at FROM logins WHERE expires_at > ?${person ? ' AND person = ?' : ''}
             ORDER BY COALESCE(last_used_at, created_at, '') DESC, id`, stamp(), ...person ? [person] : [])
        const mine = secret && hashOf(secret)
        return rows.map(row => ({...loginOf(row), ...row.id === mine ? {current: true} : {}}))
    }

    /** Ends a login by its listed id, at once: `mine`, when given, is whose it has to be. */
    async endLoginById(ref: string, mine?: string): Promise<void> {
        const row = /^[0-9a-f]{16}$/.test(ref) ? await this.get<{id: string, person: string}>(`SELECT id, person FROM logins WHERE substr(id, 1, ${LOGIN_REF}) = ?`, ref) : undefined
        if (!row || mine && row.person !== mine) throw notFound(`No login "${ref}"`)
        await this.run('DELETE FROM logins WHERE id = ?', row.id)
    }

    /** Ends every login of `person`, or everyone's, but the asking browser's: what a lost phone calls for. How many ended. */
    async endOtherLogins(person?: string, secret?: string): Promise<number> {
        const keep = secret ? hashOf(secret) : ''
        const ended = await this.all<{id: string}>(`SELECT id FROM logins WHERE id <> ?${person ? ' AND person = ?' : ''}`, keep, ...person ? [person] : [])
        await this.run(`DELETE FROM logins WHERE id <> ?${person ? ' AND person = ?' : ''}`, keep, ...person ? [person] : [])
        return ended.length
    }

    /** Whether anyone could get in by a key: the owner has a live person key. */
    async ownerHasKey(): Promise<boolean> {
        // Asked of the API when it's set up (ORR-1158), as the auth middleware asks it on the requests it holds.
        const read = await this.fromApi<WaysIn>('/api/auth/ways-in')
        if (read) return read.owner_has_key
        return !!await this.get("SELECT 1 FROM keys k JOIN people p ON p.id = k.person WHERE p.role = 'owner' AND k.kind = 'person' AND k.revoked_at IS NULL")
    }

    /** An invite for `person` to attach their first login: a link's secret, good once and for a week. */
    async invite(person: string): Promise<{secret: string, expires_at: string}> {
        await this.needsPerson(person)
        const secret = token()
        const expires_at = days(INVITE_DAYS)
        await this.run('INSERT INTO invites (id, person, expires_at) VALUES (?, ?, ?)', hashOf(secret), person, expires_at)
        return {secret, expires_at}
    }

    /** The person an account is, by its issuer and subject and never its email. With `invite`, an account orrery doesn't
     * know yet attaches to the invited person, using the invite up, in one step so it can't be used twice. An account a
     * removed person had moves to the invited person (ORR-787); one that belongs to someone here never does. */
    async identity(issuer: string, subject: string, invite?: string, name?: string): Promise<string | undefined> {
        const known = await this.get<{person: string}>(
            'SELECT i.person FROM identities i JOIN people p ON p.id = i.person WHERE i.issuer = ? AND i.subject = ? AND p.removed_at IS NULL', issuer, subject)
        if (known) return known.person
        if (!invite) return await this.firstOwner(issuer, subject, name)
        return await this.db.transaction(async () => {
            const used = await this.run('UPDATE invites SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?', stamp(), hashOf(invite), stamp())
            if (!Number(used.changes)) throw conflict('That invite has been used or has run out: ask for a new one')
            const row = await this.get<{person: string}>('SELECT person FROM invites WHERE id = ?', hashOf(invite))
            if (!row) throw conflict('That invite has been used or has run out: ask for a new one')
            const attached = await this.run(
                `INSERT INTO identities (issuer, subject, person) VALUES (?, ?, ?)
                 ON CONFLICT (issuer, subject) DO UPDATE SET person = excluded.person
                 WHERE identities.person IN (SELECT id FROM people WHERE removed_at IS NOT NULL)`, issuer, subject, row.person)
            if (!Number(attached.changes)) throw conflict('That account already belongs to someone here')
            return row.person
        })
    }

    /** On an orrery with nobody here yet, the first account to sign in through the provider becomes its owner (ORR-1185),
     * named as the provider says (`Owner` when it says nothing usable), so a new orrery needs no claim step. Once anyone
     * is here, an account orrery doesn't know needs an invite. In one transaction, and the account attaches only to an
     * owner with none yet, so two first sign-ins at once can't both get in. */
    private async firstOwner(issuer: string, subject: string, name?: string): Promise<string | undefined> {
        return await this.db.transaction(async () => {
            if (await this.get('SELECT 1 FROM people')) return undefined
            const said = (name ?? '').trim().slice(0, 60)
            const id = actorId(said)
            const display = id && !['owner', AGENT.name, 'claude', 'orrery'].includes(id) ? said : 'Owner'
            await this.nameOwner({name: display})
            const owner = actorId(display)
            const attached = await this.run(
                'INSERT INTO identities (issuer, subject, person) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM identities WHERE person = ?) ON CONFLICT (issuer, subject) DO NOTHING',
                issuer, subject, owner, owner)
            return Number(attached.changes) ? owner : undefined
        })
    }

    /** Whether auth stays on with no setting asking for it: a second person is here, or was. The first time a second
     * person is seen it's written down, so removing them doesn't open the orrery again. */
    async authStaysOn(): Promise<boolean> {
        // The API writes it down itself when it's set up (ORR-1158).
        const read = await this.fromApi<WaysIn>('/api/auth/ways-in')
        if (read) return read.stays_on
        if (await this.get("SELECT 1 FROM settings WHERE key = 'auth_on'")) return true
        const here = await this.get<{n: number}>('SELECT count(*) AS n FROM people WHERE removed_at IS NULL')
        if (Number(here?.n) < 2) return false
        await this.run("INSERT INTO settings (key, value) VALUES ('auth_on', 'true') ON CONFLICT (key) DO NOTHING")
        return true
    }

    /** Whether `name` is a person here, by name or id, or stands for one (`owner`). */
    async isPerson(name: string): Promise<boolean> {
        const id = actorId(name)
        if (id === 'owner') return true
        const read = await this.fromApi<{id: string}[]>('/api/people')
        if (read) return read.some(p => p.id === id)
        return !!await this.get('SELECT 1 FROM people WHERE id = ?', id)
    }

    private async needsPerson(id: string) {
        if (!await this.get('SELECT 1 FROM people WHERE id = ? AND removed_at IS NULL', id)) throw notFound(`No person "${id}"`)
    }
}
