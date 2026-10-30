// Secrets agents use without ever seeing them. The owner sets one (its value, the hosts it may go to, and
// the projects that may use it) and nothing gives the value back. An agent asks orrery to make a request
// with `{{secret:NAME}}` in it; orrery fills the value in, sends it only to a host the secret allows, and
// hands back the answer with the value scrubbed out. Each use is kept, without the value.
//
// The value is encrypted with ORRERY_SECRET_KEY, its hosts and projects sealed in with it: there's no
// account behind the owner's name, so where a secret may go can only be narrowed without it. Widening
// takes the value again, which an agent doesn't have, and a row changed in the database won't open.
import {createCipheriv, createDecipheriv, createHash, randomBytes} from 'node:crypto'
import {createError} from 'h3'
import type {Secret, SecretUse} from '#shared/roadmap'
import type {EventEntry} from './event-log'
import type {Field} from './input'
import {badRequest, checkInput, forbidden, isObject, notFound} from './input'
import type {Store} from './store'
import {AGENT} from './store'
import {ownerOnly, refusedFor} from './permission'

interface SecretRow { name: string, value: string, last4: string, hosts: string, projects: string | null, created_by: string, owned: number, created_at: string, updated_at: string }
interface UseRow { id: number, secret: string, method: string, host: string, path: string, project: string | null, issue: string | null, status: number | null, error: string | null, created_by: string, created_at: string }

const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/
/** A host name, with a port when it isn't https's own: `api.stripe.com`, `deploy.lan:8443`. */
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/
const PLACEHOLDER = /\{\{secret:([A-Za-z0-9_]+)\}\}/g
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const

const SECRET_FIELDS: Record<string, Field> = {
    value: {type: 'string', required: true},
    hosts: {type: 'strings', required: true},
    /** None (or null) lets every project use it. */
    projects: {type: 'strings', nullable: true},
}

const NARROW_FIELDS: Record<string, Field> = {
    hosts: {type: 'strings'},
    projects: {type: 'strings', nullable: true},
}

const EGRESS_FIELDS: Record<string, Field> = {
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
/** Who orrery's own requests are kept as, and how many of them a secret keeps. */
const ORRERY = 'orrery'
const OWN_USES = 100

export interface EgressResult {
    status: number
    headers: Record<string, string>
    body: string
    truncated?: boolean
    /** The secrets it used. */
    secrets: string[]
}

export class Secrets {
    /** `key` is ORRERY_SECRET_KEY (empty when it isn't set); `onChange` hears the list changed, or a secret was used
     * (`used`: the list's own uses moved on, and nothing in the secrets changed, so it's nothing to back up, ORR-526);
     * `note` is the event log, told who set, narrowed, deleted or sent which secret where, never a value. */
    constructor(
        private readonly store: Store,
        private readonly key: () => string,
        private readonly onChange: (secrets: Secret[], used: boolean) => void = () => {},
        private readonly send: typeof fetch = globalThis.fetch,
        private readonly note: (entry: EventEntry) => void = () => {},
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
        return {...secretOf(row, undefined), last_used: uses[0] ?? null, uses}
    }

    /** Sets a secret, new or replacing the one with this name: `{value, hosts, projects?}`. */
    async set(name: string, body: unknown, actor = AGENT): Promise<{secret: Secret, created: boolean}> {
        ownerOnly(actor, 'secrets.write')
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
        this.note({level: 'info', kind: 'secret.set', message: `${actor.name} ${before ? 'replaced' : 'set'} ${name}, for ${hosts.join(', ')}`,
            details: {by: actor.name, secret: name, hosts, ...projects ? {projects} : {}, created: !before}})
        return {secret: (await this.get(name)), created: !before}
    }

    /** Narrows where a secret may go, `{hosts?, projects?}`, without its value; widening takes `set`. */
    async narrow(name: string, body: unknown, actor = AGENT): Promise<Secret> {
        ownerOnly(actor, 'secrets.write')
        const row = await this.row(name)
        const input = checkInput(body, NARROW_FIELDS, true)
        const was = {hosts: JSON.parse(row.hosts) as string[], projects: row.projects ? JSON.parse(row.projects) as string[] : null}
        const hosts = input.hosts === undefined ? was.hosts : hostsOf(input.hosts as string[])
        const projects = input.projects === undefined ? was.projects : await this.projectsOf(input.projects as string[] | null)
        if (!hosts.length) throw badRequest('"hosts" needs at least one host; delete the secret to stop it going anywhere')
        const wasIn = was.projects
        const wider = hosts.some(h => !was.hosts.includes(h)) || (wasIn !== null && (projects === null || projects.some(p => !wasIn.includes(p))))
        if (wider) throw forbidden(`Letting ${name} go somewhere new takes its value again: PUT /api/secrets/${name} with {value, hosts, projects}`)
        const value = this.open(row)
        await this.db.run('UPDATE secrets SET value = ?, hosts = ?, projects = ?, updated_at = ? WHERE name = ?',
            this.seal(name, value, hosts, projects), JSON.stringify(hosts), projects && JSON.stringify(projects), new Date().toISOString(), name)
        await this.changed()
        this.note({level: 'info', kind: 'secret.narrowed', message: `${actor.name} narrowed ${name} to ${hosts.join(', ')}`,
            details: {by: actor.name, secret: name, hosts, ...projects ? {projects} : {}}})
        return await this.get(name)
    }

    async delete(name: string, actor = AGENT) {
        ownerOnly(actor, 'secrets.write')
        await this.row(name)
        await this.db.run('DELETE FROM secrets WHERE name = ?', name)
        await this.db.run('DELETE FROM secret_uses WHERE secret = ?', name)
        await this.changed()
        this.note({level: 'info', kind: 'secret.deleted', message: `${actor.name} deleted ${name}`, details: {by: actor.name, secret: name}})
    }

    /** Makes a request for an agent with the secrets it names filled in: `{url, method?, headers?, body?, project?, issue?}`. */
    async egress(body: unknown, actor = AGENT): Promise<EgressResult> {
        const input = checkInput(body, EGRESS_FIELDS)
        const method = String(input.method ?? 'GET')
        const headers = input.headers ? JSON.parse(String(input.headers)) as Record<string, string> : {}
        const text = input.body === undefined || method === 'GET' || method === 'HEAD' ? undefined : String(input.body)
        const template = String(input.url)
        const names = [...new Set([template, ...Object.values(headers), text ?? ''].flatMap(part => [...part.matchAll(PLACEHOLDER)].flatMap(m => m[1] ?? [])))]
        if (!names.length) throw badRequest('Put a secret in the request as {{secret:NAME}}; orrery only makes requests that use one')
        // Says what the caller says it's for: a guard against using a key in the wrong project by mistake,
        // not a boundary, as nothing proves who's calling.
        const project = input.project === undefined ? null : await this.store.projectId(String(input.project))
        const issue = input.issue === undefined ? null : String(input.issue)

        const secrets = new Map<string, {row: SecretRow, hosts: string[], value: string}>()
        for (const name of names) {
            const row = await this.db.get<SecretRow>('SELECT * FROM secrets WHERE name = ?', name)
            if (!row) throw notFound(`No secret ${name}; GET /api/secrets lists them`)
            const projects = row.projects ? JSON.parse(row.projects) as string[] : null
            if (projects && (!project || !projects.includes(project))) throw refusedFor('secrets.egress', `${name} is only for ${projects.join(', ')}; send the "project" it's for`)
            secrets.set(name, {row, hosts: JSON.parse(row.hosts), value: this.open(row)})
        }
        const {scrub, cut} = scrubber(secrets)
        /** Each placeholder in `part` replaced by its value, escaped as `escape` says for where it goes. */
        const fill = (part: string, escape: (value: string) => string = value => value) =>
            part.replace(PLACEHOLDER, (whole, name: string) => {
                const secret = secrets.get(name)
                return secret ? escape(secret.value) : whole
            })

        let url: URL
        try {
            url = new URL(fillUrl(template, fill))
        } catch {
            throw badRequest(`"url" isn't a URL: ${template}`)
        }
        if (url.protocol !== 'https:') throw badRequest('Secrets only go over https')
        const host = scrub(url.host)
        for (const [name, {hosts}] of secrets) {
            if (!hosts.includes(url.host)) throw refusedFor('secrets.egress', `${name} may only go to ${hosts.join(', ')}, not ${host}`)
        }

        const sent = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, fill(v)]))
        if (text !== undefined && typeof (body as {body?: unknown}).body !== 'string' && !Object.keys(sent).some(k => k.toLowerCase() === 'content-type')) {
            sent['Content-Type'] = 'application/json'
        }
        const type = Object.entries(sent).find(([k]) => k.toLowerCase() === 'content-type')?.[1].toLowerCase() ?? ''
        const inBody = type.includes('json') ? (value: string) => JSON.stringify(value).slice(1, -1)
            : type.includes('x-www-form-urlencoded') ? encodeURIComponent
                : undefined
        const record = async (status: number | null, error: string | null) => {
            for (const name of names) {
                await this.db.run('INSERT INTO secret_uses (secret, method, host, path, project, issue, status, error, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    name, method, host, scrub(url.pathname), project, issue, status, error, actor.name, new Date().toISOString())
            }
            await this.changed(true)
            // Not its path: what the secret is used on is the secret's own record, not the log's.
            this.note({level: 'info', kind: 'egress.called', ...project ? {project} : {},
                message: `${actor.name} sent ${names.join(', ')} to ${method} ${host}: ${status ?? error}`,
                details: {by: actor.name, secrets: names, method, host, status, ...issue ? {issue} : {}, ...error ? {error} : {}}})
        }

        let response: Response
        try {
            response = await this.send(url, {method, headers: sent, body: text === undefined ? undefined : fill(text, inBody), redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT)})
        } catch (error) {
            const reason = scrub((error as Error).message)
            await record(null, reason)
            throw createError({statusCode: 502, statusMessage: 'Bad Gateway', message: `The request to ${host} failed: ${reason}`})
        }
        // Read past the cut by more than any form of a value is long, so one there is scrubbed whole first.
        let read: {bytes: Uint8Array, more: boolean}
        try {
            read = await readUpTo(response, MAX_BODY + 8 * Math.max(...[...secrets.values()].map(s => s.value.length)) + 64)
        } catch (error) {
            const reason = scrub((error as Error).message)
            await record(response.status, reason)
            throw createError({statusCode: 502, statusMessage: 'Bad Gateway', message: `The answer from ${host} broke off: ${reason}`})
        }
        await record(response.status, null)
        const answer = Object.fromEntries([...response.headers].filter(([k]) => k !== 'set-cookie').map(([k, v]) => [k, scrub(v)]))
        const whole = scrub(new TextDecoder().decode(read.bytes))
        const truncated = read.more || whole.length > MAX_BODY
        return {
            status: response.status,
            headers: answer,
            body: truncated ? cut(whole.slice(0, MAX_BODY)) : whole,
            ...truncated ? {truncated: true} : {},
            secrets: names,
        }
    }

    /** orrery's own request to `url` for `project` (a GET, or `init`'s method and body), with the secret `name` as a
     * bearer token when there's one that may go to its host and be used for the project, else without. Kept in the
     * secret's uses as orrery's (the latest `OWN_USES`), and not logged: it runs every minute or two. */
    async own(url: string, name: string, project: string, headers: Record<string, string> = {}, init: {method?: 'GET' | 'POST', body?: string} = {}): Promise<{response: Response, secret: boolean}> {
        const target = new URL(url)
        const value = await this.ownValue(target, name, project)
        const method = init.method ?? 'GET'
        const sent = value ? {...headers, Authorization: `Bearer ${value}`} : headers
        const record = async (status: number | null, error: string | null) => {
            if (!value) return
            await this.db.run('INSERT INTO secret_uses (secret, method, host, path, project, issue, status, error, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                name, method, target.host, target.pathname, project, null, status, error, ORRERY, new Date().toISOString())
            await this.db.run(`DELETE FROM secret_uses WHERE secret = ? AND created_by = ? AND id NOT IN
                (SELECT id FROM (SELECT id FROM secret_uses WHERE secret = ? AND created_by = ? ORDER BY id DESC LIMIT ${OWN_USES}) AS latest)`, name, ORRERY, name, ORRERY)
            await this.changed(true)
        }
        try {
            const response = await this.send(target, {method, headers: sent, ...init.body === undefined ? {} : {body: init.body}, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT)})
            await record(response.status, null)
            return {response, secret: !!value}
        } catch (error) {
            const reason = value ? (error as Error).message.replaceAll(value, '…') : (error as Error).message
            await record(null, reason)
            throw new Error(`The request to ${target.host} failed: ${reason}`, {cause: error})
        }
    }

    /** Why a secret `name` that's set wouldn't go to `url` for `project` (ORR-632): its hosts or projects leave them out,
     * or this orrery's key can't open it. Undefined when it would go, or there's none to send. */
    async ownProblem(url: string, name: string, project: string): Promise<string | undefined> {
        const row = await this.db.get<SecretRow>('SELECT * FROM secrets WHERE name = ?', name)
        const {host, protocol} = new URL(url)
        if (!row || protocol !== 'https:') return undefined
        const hosts = JSON.parse(row.hosts) as string[]
        if (!hosts.includes(host)) return `the ${name} secret is set, but may only go to ${hosts.join(', ')}: set it again with ${host} among its hosts`
        const projects = row.projects ? JSON.parse(row.projects) as string[] : null
        if (projects && !projects.includes(project)) return `the ${name} secret is set, but not for ${project}: set it again with ${project} among its projects`
        try {
            this.open(row)
            return undefined
        } catch {
            return `the ${name} secret is set, but this orrery's key can't open it: set it again`
        }
    }

    /** Whether `own` would send the secret `name` to `url` for `project`, asking nothing. */
    async ownsFor(url: string, name: string, project: string): Promise<boolean> {
        return !!await this.ownValue(new URL(url), name, project)
    }

    /** The secret `name`'s value, when there's one that may go to `target`'s host and be used for `project`. */
    private async ownValue(target: URL, name: string, project: string): Promise<string | null> {
        const row = await this.db.get<SecretRow>('SELECT * FROM secrets WHERE name = ?', name)
        if (!row || target.protocol !== 'https:' || !(JSON.parse(row.hosts) as string[]).includes(target.host)
            || (row.projects && !(JSON.parse(row.projects) as string[]).includes(project))) return null
        try {
            return this.open(row)
        } catch {
            // No key, or not the one it was set with: asked without it, the way it would be with no secret.
            return null
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
        const ids = await Promise.all(sent.map(p => this.store.projectId(p)))
        return [...new Set(ids)].sort()
    }

    private async changed(used = false) {
        this.onChange(await this.list(), used)
    }

    private cipherKey(): Buffer {
        const key = this.key()
        if (!key) throw createError({statusCode: 503, statusMessage: 'Service Unavailable', message: "Secrets need a key, and orrery couldn't keep one in orrery.key beside its database: set ORRERY_SECRET_KEY to a long random string (openssl rand -base64 32) and restart orrery"})
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

    /** `text` with every secret's value taken out, the way an answer is (for the event log); one that can't be opened is let be. */
    async scrub(text: string): Promise<string> {
        return (await this.scrubber())(text)
    }

    /** What takes every secret's value out of a text, for many texts at the cost of one. */
    async scrubber(): Promise<(text: string) => string> {
        const secrets = new Map<string, {value: string}>()
        for (const row of await this.db.all<SecretRow>('SELECT * FROM secrets')) {
            try {
                secrets.set(row.name, {value: this.open(row)})
            } catch {
                // Sealed with another key: not one this orrery can send, so not one it would log.
            }
        }
        if (!secrets.size) return text => text
        const {scrub} = scrubber(secrets)
        return scrub
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
            throw createError({statusCode: 503, statusMessage: 'Service Unavailable', message: `${row.name} won't open: ORRERY_SECRET_KEY isn't the key it was set with, or it was changed outside orrery. Set it again`})
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
    if (!isObject(value) || !Object.values(value).every(v => typeof v === 'string')) {
        throw new Error('should be an object of header names to text')
    }
    return JSON.stringify(value)
}

/** Up to `limit` bytes of an answer's body, and whether there was more; the rest isn't read. */
async function readUpTo(response: Response, limit: number): Promise<{bytes: Uint8Array, more: boolean}> {
    const reader = response.body?.getReader()
    if (!reader) return {bytes: new Uint8Array(), more: false}
    const chunks: Uint8Array[] = []
    let length = 0
    while (length <= limit) {
        const {done, value} = await reader.read()
        if (done) return {bytes: Buffer.concat(chunks), more: false}
        chunks.push(value)
        length += value.length
    }
    await reader.cancel().catch(() => {})
    return {bytes: Buffer.concat(chunks).subarray(0, limit), more: true}
}

const BASE64 = /[A-Za-z0-9+/_-]/

/** `text` with each base64 word that has `core` in it, padding and all, replaced by `by`. */
function replaceWords(text: string, core: string, by: string): string {
    let out = ''
    let from = 0
    for (let at = text.indexOf(core); at >= 0; at = text.indexOf(core, from)) {
        let start = at
        while (start > from && BASE64.test(text.charAt(start - 1))) start--
        let end = at + core.length
        while (end < text.length && BASE64.test(text.charAt(end))) end++
        while (text[end] === '=') end++
        out += text.slice(from, start) + by
        from = end
    }
    return out + text.slice(from)
}

/** The url with its placeholders filled for where each sits: one that starts it (a webhook's whole address, or
 * its base) as it is, the hosts check guarding where it goes; in the path escaped but for its `/` (Slack's
 * `T000/B000/XXX`); in the query or fragment escaped whole. */
function fillUrl(template: string, fill: (part: string, escape?: (value: string) => string) => string): string {
    const lead = template.match(/^\{\{secret:[A-Za-z0-9_]+\}\}/)?.[0] ?? ''
    const rest = template.slice(lead.length)
    // Where the query starts, outside a placeholder (a name can't hold `?` or `#`, so the first is it).
    const at = rest.search(/[?#]/)
    const [path, query] = at < 0 ? [rest, ''] : [rest.slice(0, at), rest.slice(at)]
    return fill(lead) + fill(path, inPath) + fill(query, encodeURIComponent)
}

const inPath = (value: string) => encodeURIComponent(value).replaceAll('%2F', '/')

/** `scrub` puts the placeholder back wherever a value shows: as it is, URL- or form-encoded, JSON-escaped,
 * or inside base64 (as Basic auth sends it, a user name and all). `cut` drops what's left of one at the end
 * of an answer cut short. It stops a value echoed back; the hosts are what stop one being sent away on purpose. */
function scrubber(secrets: Map<string, {value: string}>): {scrub: (text: string) => string, cut: (text: string) => string} {
    const json = (value: string) => JSON.stringify(value).slice(1, -1)
    const forms = [...secrets].flatMap(([name, {value}]) => [
        // The URL's own escaping of a query adds `%27` for `'`, which encodeURIComponent leaves.
        value, encodeURIComponent(value), encodeURIComponent(value).replaceAll("'", '%27'), inPath(value),
        new URLSearchParams({v: value}).toString().slice(2), json(value), json(value).replaceAll('/', '\\/'),
    ].map(form => ({form, name})))
        .sort((a, b) => b.form.length - a.form.length)
    // In base64 the value's characters depend on where it starts, so each of the three starts has its own run
    // of characters that only the value decides; one found takes the whole base64 word it's in.
    const cores = [...secrets].flatMap(([name, {value}]) => [0, 1, 2].flatMap(start => {
        const bytes = Buffer.concat([Buffer.alloc(start), Buffer.from(value)])
        const [from, to] = [Math.ceil(start * 8 / 6), Math.floor(bytes.length * 8 / 6)]
        return [bytes.toString('base64').slice(from, to), bytes.toString('base64url').slice(from, to)]
    }).filter(core => core.length >= 4).map(core => ({core, name})))
    const starts = [...forms.map(f => f.form), ...cores.map(c => c.core)]
    return {
        scrub: text => {
            const plain = forms.reduce((out, {form, name}) => out.replaceAll(form, `{{secret:${name}}}`), text)
            return cores.reduce((out, {core, name}) => replaceWords(out, core, `{{secret:${name}}}`), plain)
        },
        cut: text => {
            const left = Math.max(0, ...starts.map(form => {
                for (let k = Math.min(form.length - 1, text.length); k > 0; k--) if (text.endsWith(form.slice(0, k))) return k
                return 0
            }))
            return text.slice(0, text.length - left)
        },
    }
}

function secretOf(row: SecretRow, last: UseRow | undefined): Secret {
    return {
        name: row.name,
        last4: row.last4,
        hosts: JSON.parse(row.hosts),
        projects: row.projects ? JSON.parse(row.projects) : null,
        created_by: row.created_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
        last_used: last ? useOf(last) : null,
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
        created_by: row.created_by,
        created_at: row.created_at,
    }
}
