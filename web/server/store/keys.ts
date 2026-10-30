// Who's who when auth is on (ORR-664): the keys people make, the logins a browser holds, and the invites and identities
// that tie a provider's account to a person. Only hashes are kept, looked up on each request, so revoking works at once.
// Below the projects, above the people.
import {createHash, randomBytes} from 'node:crypto'
import type {KeyKind, KeyRecord} from '#shared/roadmap'
import {badRequest, conflict, notFound} from '../utils/input'
import {PeopleStore} from './people'
import {actorId, stamp} from './schema'

/** A credential once checked: the person behind it, and the kind of key if it was one. */
export interface Holder {
    person: string
    owner: boolean
    kind?: KeyKind
}

type KeyRow = {id: string, person: string, kind: KeyKind, name: string, created_at: string, last_used_at: string | null, revoked_at: string | null}
const keyOf = ({id, person, kind, name, created_at, last_used_at, revoked_at}: KeyRow): KeyRecord =>
    ({id, person, kind, name, created_at, ...last_used_at ? {last_used_at} : {}, ...revoked_at ? {revoked_at} : {}})

const hashOf = (secret: string) => createHash('sha256').update(secret).digest('hex')
const token = () => randomBytes(32).toString('base64url')
const LOGIN_DAYS = 30
const INVITE_DAYS = 7
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString()
/** A key's last use is only for the list, so it's written at most this often. */
const USED_EVERY = 60_000

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

    /** Revokes a key, at once; revoking it again changes nothing. `mine`, when given, is whose it has to be. */
    async revokeKey(id: string, mine?: string): Promise<void> {
        const key = await this.get<KeyRow>('SELECT * FROM keys WHERE id = ?', id)
        if (!key || mine && key.person !== mine) throw notFound(`No key "${id}"`)
        if (!key.revoked_at) await this.run('UPDATE keys SET revoked_at = ? WHERE id = ?', stamp(), id)
    }

    /** Who a key is, if it's live and its person is still here. */
    async keyHolder(secret: string): Promise<Holder | undefined> {
        const row = await this.get<{id: string, kind: KeyKind, person: string, role: string, last_used_at: string | null}>(
            `SELECT k.id, k.kind, k.person, p.role, k.last_used_at FROM keys k JOIN people p ON p.id = k.person
             WHERE k.hash = ? AND k.revoked_at IS NULL AND p.removed_at IS NULL`, hashOf(secret))
        if (!row) return undefined
        if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > USED_EVERY) await this.run('UPDATE keys SET last_used_at = ? WHERE id = ?', stamp(), row.id)
        return {person: row.person, owner: row.role === 'owner', kind: row.kind}
    }

    /** Starts a browser's login for `person`: what goes in its cookie. */
    async startLogin(person: string): Promise<{secret: string, days: number}> {
        const secret = token()
        await this.run('DELETE FROM logins WHERE expires_at < ?', stamp())
        await this.run('INSERT INTO logins (id, person, expires_at) VALUES (?, ?, ?)', hashOf(secret), person, days(LOGIN_DAYS))
        return {secret, days: LOGIN_DAYS}
    }

    /** Who a login's cookie is, if it hasn't run out and they're still here. */
    async loginHolder(secret: string): Promise<Holder | undefined> {
        const row = await this.get<{person: string, role: string}>(
            `SELECT l.person, p.role FROM logins l JOIN people p ON p.id = l.person WHERE l.id = ? AND l.expires_at > ? AND p.removed_at IS NULL`, hashOf(secret), stamp())
        return row && {person: row.person, owner: row.role === 'owner'}
    }

    async endLogin(secret: string): Promise<void> {
        await this.run('DELETE FROM logins WHERE id = ?', hashOf(secret))
    }

    /** Whether anyone could get in by a key: the owner has a live person key. */
    async ownerHasKey(): Promise<boolean> {
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
     * know yet attaches to the invited person, using the invite up, in one step so it can't be used twice. */
    async identity(issuer: string, subject: string, invite?: string): Promise<string | undefined> {
        const known = await this.get<{person: string}>(
            'SELECT i.person FROM identities i JOIN people p ON p.id = i.person WHERE i.issuer = ? AND i.subject = ? AND p.removed_at IS NULL', issuer, subject)
        if (known) return known.person
        if (!invite) return undefined
        return await this.db.transaction(async () => {
            const used = await this.run('UPDATE invites SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?', stamp(), hashOf(invite), stamp())
            if (!Number(used.changes)) throw conflict('That invite has been used or has run out: ask for a new one')
            const row = await this.get<{person: string}>('SELECT person FROM invites WHERE id = ?', hashOf(invite))
            if (!row) throw conflict('That invite has been used or has run out: ask for a new one')
            await this.run('INSERT INTO identities (issuer, subject, person) VALUES (?, ?, ?)', issuer, subject, row.person)
            return row.person
        })
    }

    /** Whether auth stays on with no setting asking for it: a second person is here, or was. The first time a second
     * person is seen it's written down, so removing them doesn't open the orrery again. */
    async authStaysOn(): Promise<boolean> {
        if (await this.get("SELECT 1 FROM settings WHERE key = 'auth_on'")) return true
        const here = await this.get<{n: number}>('SELECT count(*) AS n FROM people WHERE removed_at IS NULL')
        if (Number(here?.n) < 2) return false
        await this.run("INSERT INTO settings (key, value) VALUES ('auth_on', 'true') ON CONFLICT (key) DO NOTHING")
        return true
    }

    /** Whether `name` is a person here, by name or id, or stands for one (`owner`). */
    async isPerson(name: string): Promise<boolean> {
        const id = actorId(name)
        return id === 'owner' || !!await this.get('SELECT 1 FROM people WHERE id = ?', id)
    }

    private async needsPerson(id: string) {
        if (!await this.get('SELECT 1 FROM people WHERE id = ? AND removed_at IS NULL', id)) throw notFound(`No person "${id}"`)
    }
}
