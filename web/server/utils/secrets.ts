// Secrets agents use without ever seeing them. The owner sets one (its value, the hosts it may go to, and
// the projects that may use it) and nothing gives the value back. An agent asks Orrery to make a request
// with `{{secret:NAME}}` in it; Orrery fills the value in, sends it only to a host the secret allows, and
// hands back the answer with the value scrubbed out. Each use is kept, without the value.
//
// The value is encrypted with ORRERY_SECRET_KEY, its hosts and projects sealed in with it: there's no
// account behind the owner's name, so where a secret may go can only be narrowed without it. Widening
// takes the value again, which an agent doesn't have, and a row changed in the database won't open.
import {createCipheriv, createDecipheriv, createHash, randomBytes} from 'node:crypto'
import {createError} from 'h3'
import type {Secret, SecretUse} from '#shared/roadmap'
import type {Field} from './input'
import {badRequest, checkInput, forbidden, notFound} from './input'
import type {Actor, Store} from './store'
import {AGENT} from './store'

interface SecretRow { name: string, value: string, last4: string, hosts: string, projects: string | null, created_by: string, owned: number, created_at: string, updated_at: string }
interface UseRow { id: number, secret: string, method: string, host: string, path: string, project: string | null, issue: string | null, status: number | null, error: string | null, created_by: string, created_at: string }

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/
/** A host name, with a port when it isn't https's own: `api.stripe.com`, `deploy.lan:8443`. */
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/
const PLACEHOLDER = /\{\{secret:([A-Za-z0-9_]+)\}\}/g
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const

export const SECRET_FIELDS: Record<string, Field> = {
    value: {type: 'string', required: true},
    hosts: {type: 'strings', required: true},
    /** None (or null) lets every project use it. */
    projects: {type: 'strings', nullable: true},
}

const NARROW_FIELDS: Record<string, Field> = {
    hosts: {type: 'strings'},
    projects: {type: 'strings', nullable: true},
}

export const EGRESS_FIELDS: Record<string, Field> = {
    url: {type: 'string', required: true},
    method: {type: 'string', values: METHODS},
    headers: {type: 'json', parse: parseHeaders},
    /** Text as it is; anything else goes as JSON. */
    body: {type: 'json', parse: value => typeof value === 'string' ? value : JSON.stringify(value)},
    /** The project and issue it's for: a secret kept to some projects needs `project`, and both go in its record. */
    project: {type: 'string'},
    issue: {type: 'string'},
}

/** How much of an answer comes back; the rest is cut, with `truncated`. */
const MAX_BODY = 1_000_000
const TIMEOUT = 30_000
/** How many uses a secret shows. */
const USES = 20

export interface EgressResult {
    status: number
    headers: Record<string, string>
    body: string
    truncated?: boolean
    /** The secrets it used. */
    secrets: string[]
}

export class Secrets {
    /** `key` is ORRERY_SECRET_KEY (empty when it isn't set); `onChange` hears the list changed or a secret was used. */
    constructor(
        private readonly store: Store,
        private readonly key: () => string,
        private readonly onChange: (secrets: Secret[]) => void = () => {},
        private readonly send: typeof fetch = globalThis.fetch,
    ) {}

    private get db() {
        return this.store.db
    }

    /** Every secret, by name, without its value. */
    async list(): Promise<Secret[]> {
        const rows = await this.db.all<SecretRow>('SELECT * FROM secrets ORDER BY name')
        const last = await this.db.all<UseRow>('SELECT * FROM secret_uses WHERE id IN (SELECT max(id) FROM secret_uses GROUP BY secret)')
        return rows.map(row => secretOf(row, last.find(u => u.secret === row.name)))
    }

    /** A secret with its latest uses. */
    async get(name: string): Promise<Secret & {uses: SecretUse[]}> {
        const row = await this.row(name)
        const uses = (await this.db.all<UseRow>('SELECT * FROM secret_uses WHERE secret = ? ORDER BY id DESC LIMIT ?', name, USES)).map(useOf)
        return {...secretOf(row, undefined), lastUsed: uses[0] ?? null, uses}
    }

    /** Sets a secret, new or replacing the one with this name: `{value, hosts, projects?}`. */
    async set(name: string, body: unknown, actor = AGENT): Promise<{secret: Secret, created: boolean}> {
        this.ownerOnly(actor)
        if (!SECRET_NAME.test(name)) throw badRequest(`"${name}" isn't a secret's name; use capitals, digits and _, e.g. STRIPE_KEY`)
        const input = checkInput(body, SECRET_FIELDS)
        const value = String(input.value).trim()
        if (value.length < 8) throw badRequest('"value" is too short to be a secret (8 characters at least)')
        const hosts = hostsOf(input.hosts as string[])
        if (!hosts.length) throw badRequest('"hosts" needs at least one host it may be sent to, e.g. api.stripe.com')
        const projects = await this.projectsOf(input.projects as string[] | null | undefined)
        const now = new Date().toISOString()
        const before = await this.db.get<SecretRow>('SELECT * FROM secrets WHERE name = ?', name)
        await this.db.run(`INSERT INTO secrets (name, value, last4, hosts, projects, created_by, owned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (name) DO UPDATE SET value = excluded.value, last4 = excluded.last4, hosts = excluded.hosts, projects = excluded.projects, updated_at = excluded.updated_at`,
        name, this.seal(name, value, hosts, projects), value.slice(-4), JSON.stringify(hosts), projects && JSON.stringify(projects), actor.name, Number(actor.owner), now, now)
        await this.changed()
        return {secret: (await this.get(name)), created: !before}
    }

    /** Narrows where a secret may go, `{hosts?, projects?}`, without its value; widening takes `set`. */
    async narrow(name: string, body: unknown, actor = AGENT): Promise<Secret> {
        this.ownerOnly(actor)
        const row = await this.row(name)
        const input = checkInput(body, NARROW_FIELDS, true)
        const was = {hosts: JSON.parse(row.hosts) as string[], projects: row.projects ? JSON.parse(row.projects) as string[] : null}
        const hosts = input.hosts === undefined ? was.hosts : hostsOf(input.hosts as string[])
        const projects = input.projects === undefined ? was.projects : await this.projectsOf(input.projects as string[] | null)
        if (!hosts.length) throw badRequest('"hosts" needs at least one host; delete the secret to stop it going anywhere')
        const wider = hosts.some(h => !was.hosts.includes(h)) || (was.projects !== null && (projects === null || projects.some(p => !was.projects!.includes(p))))
        if (wider) throw forbidden(`Letting ${name} go somewhere new takes its value again: PUT /api/secrets/${name} with {value, hosts, projects}`)
        const value = this.open(row)
        await this.db.run('UPDATE secrets SET value = ?, hosts = ?, projects = ?, updated_at = ? WHERE name = ?',
            this.seal(name, value, hosts, projects), JSON.stringify(hosts), projects && JSON.stringify(projects), new Date().toISOString(), name)
        await this.changed()
        return await this.get(name)
    }

    async delete(name: string, actor = AGENT) {
        this.ownerOnly(actor)
        await this.row(name)
        await this.db.run('DELETE FROM secrets WHERE name = ?', name)
        await this.changed()
    }

    /** Makes a request for an agent with the secrets it names filled in: `{url, method?, headers?, body?, project?, issue?}`. */
    async egress(body: unknown, actor = AGENT): Promise<EgressResult> {
        const input = checkInput(body, EGRESS_FIELDS)
        const method = String(input.method ?? 'GET')
        const headers = input.headers ? JSON.parse(String(input.headers)) as Record<string, string> : {}
        const text = input.body === undefined || method === 'GET' || method === 'HEAD' ? undefined : String(input.body)
        const template = String(input.url)
        const names = [...new Set([template, ...Object.values(headers), text ?? ''].flatMap(part => [...part.matchAll(PLACEHOLDER)].map(m => m[1]!)))]
        if (!names.length) throw badRequest('Put a secret in the request as {{secret:NAME}}; Orrery only makes requests that use one')
        const project = input.project === undefined ? null : (await this.store.project(String(input.project))).id
        const issue = input.issue === undefined ? null : String(input.issue)

        const secrets = new Map<string, {row: SecretRow, hosts: string[], value: string}>()
        for (const name of names) {
            const row = await this.db.get<SecretRow>('SELECT * FROM secrets WHERE name = ?', name)
            if (!row) throw notFound(`No secret ${name}; GET /api/secrets lists them`)
            const projects = row.projects ? JSON.parse(row.projects) as string[] : null
            if (projects && (!project || !projects.includes(project))) throw forbidden(`${name} is only for ${projects.join(', ')}; send the "project" it's for`)
            secrets.set(name, {row, hosts: JSON.parse(row.hosts), value: this.open(row)})
        }
        const scrub = scrubber(secrets)
        const fill = (part: string) => part.replace(PLACEHOLDER, (whole, name: string) => secrets.get(name)?.value ?? whole)

        let url: URL
        try {
            url = new URL(fill(template))
        } catch {
            throw badRequest(`"url" isn't a URL: ${template}`)
        }
        if (url.protocol !== 'https:') throw badRequest('Secrets only go over https')
        const host = scrub(url.host)
        for (const [name, {hosts}] of secrets) {
            if (!hosts.includes(url.host)) throw forbidden(`${name} may only go to ${hosts.join(', ')}, not ${host}`)
        }

        const sent = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, fill(v)]))
        if (text !== undefined && typeof (body as {body?: unknown}).body !== 'string' && !Object.keys(sent).some(k => k.toLowerCase() === 'content-type')) {
            sent['Content-Type'] = 'application/json'
        }
        const record = async (status: number | null, error: string | null) => {
            for (const name of names) {
                await this.db.run('INSERT INTO secret_uses (secret, method, host, path, project, issue, status, error, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    name, method, host, scrub(url.pathname), project, issue, status, error, actor.name, new Date().toISOString())
            }
            await this.changed()
        }

        let response: Response
        try {
            response = await this.send(url, {method, headers: sent, body: text === undefined ? undefined : fill(text), redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT)})
        } catch (error) {
            const reason = scrub((error as Error).message)
            await record(null, reason)
            throw createError({statusCode: 502, statusMessage: 'Bad Gateway', message: `The request to ${host} failed: ${reason}`})
        }
        const bytes = new Uint8Array(await response.arrayBuffer())
        await record(response.status, null)
        const answer = Object.fromEntries([...response.headers].filter(([k]) => k !== 'set-cookie').map(([k, v]) => [k, scrub(v)]))
        return {
            status: response.status,
            headers: answer,
            body: scrub(new TextDecoder().decode(bytes.subarray(0, MAX_BODY))),
            ...bytes.length > MAX_BODY ? {truncated: true} : {},
            secrets: names,
        }
    }

    private async row(name: string): Promise<SecretRow> {
        const row = await this.db.get<SecretRow>('SELECT * FROM secrets WHERE name = ?', name)
        if (!row) throw notFound(`No secret ${name}`)
        return row
    }

    /** Projects as kept: each one there, by its id; none is null (any). */
    private async projectsOf(sent: string[] | null | undefined): Promise<string[] | null> {
        if (!sent?.length) return null
        const ids = await Promise.all(sent.map(async p => (await this.store.project(p)).id))
        return [...new Set(ids)].sort()
    }

    private ownerOnly(actor: Actor) {
        if (!actor.owner) throw forbidden('Only the owner sets secrets; send Orrery-Actor: <owner>')
    }

    private async changed() {
        this.onChange(await this.list())
    }

    private cipherKey(): Buffer {
        const key = this.key()
        if (!key) throw createError({statusCode: 503, statusMessage: 'Service Unavailable', message: 'Secrets need ORRERY_SECRET_KEY: set it to a long random string (openssl rand -base64 32) and restart Orrery'})
        return createHash('sha256').update(key).digest()
    }

    /** The value encrypted, with its name, hosts and projects as what it's sealed to. */
    private seal(name: string, value: string, hosts: string[], projects: string[] | null): string {
        const iv = randomBytes(12)
        const cipher = createCipheriv('aes-256-gcm', this.cipherKey(), iv)
        cipher.setAAD(Buffer.from(JSON.stringify([name, hosts, projects])))
        const sealed = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
        return `v1:${Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64')}`
    }

    private open(row: SecretRow): string {
        const key = this.cipherKey()
        try {
            const raw = Buffer.from(row.value.slice(3), 'base64')
            const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
            decipher.setAAD(Buffer.from(JSON.stringify([row.name, JSON.parse(row.hosts), row.projects ? JSON.parse(row.projects) : null])))
            decipher.setAuthTag(raw.subarray(12, 28))
            return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
        } catch {
            throw createError({statusCode: 503, statusMessage: 'Service Unavailable', message: `${row.name} won't open: ORRERY_SECRET_KEY isn't the key it was set with, or it was changed outside Orrery. Set it again`})
        }
    }
}

/** Hosts as kept: lowercase, sorted, without a scheme or path pasted along. */
function hostsOf(sent: string[]): string[] {
    const hosts = sent.map(h => h.trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/.*$/, '').replace(/:443$/, ''))
    const wrong = hosts.find(h => !HOST.test(h))
    if (wrong !== undefined) throw badRequest(`"${wrong}" isn't a host name; give one like api.stripe.com`)
    return [...new Set(hosts)].sort()
}

function parseHeaders(value: unknown): string {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || !Object.values(value).every(v => typeof v === 'string')) {
        throw new Error('should be an object of header names to text')
    }
    return JSON.stringify(value)
}

/** Puts the placeholder back wherever a value shows: as it is, URL-encoded, or in base64 (as Basic auth sends it).
 * It stops a value echoed back; the hosts are what stop one being sent away on purpose. */
function scrubber(secrets: Map<string, {value: string}>): (text: string) => string {
    const base64 = (text: string) => Buffer.from(text).toString('base64')
    const forms = [...secrets].flatMap(([name, {value}]) => [value, encodeURIComponent(value), base64(value), base64(`${value}:`)]
        .map(form => ({form, name})))
        .sort((a, b) => b.form.length - a.form.length)
    return text => forms.reduce((out, {form, name}) => out.replaceAll(form, `{{secret:${name}}}`), text)
}

function secretOf(row: SecretRow, last: UseRow | undefined): Secret {
    return {
        name: row.name,
        last4: row.last4,
        hosts: JSON.parse(row.hosts),
        projects: row.projects ? JSON.parse(row.projects) : null,
        createdBy: row.created_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastUsed: last ? useOf(last) : null,
    }
}

function useOf(row: UseRow): SecretUse {
    return {
        id: row.id,
        secret: row.secret,
        method: row.method,
        host: row.host,
        path: row.path,
        project: row.project,
        issue: row.issue,
        status: row.status,
        error: row.error,
        createdBy: row.created_by,
        createdAt: row.created_at,
    }
}
