import {readdirSync, statSync} from 'node:fs'
import {join, relative} from 'node:path'
import {fileURLToPath} from 'node:url'
import type {Browser, Page} from '@playwright/test'
import {expect, test} from '@playwright/test'

// Every route the Nuxt server answers itself (server/api), called by people who aren't bo with bo's ids, must answer
// as it does with ids that aren't there, and give nothing of bo's away (ORR-1352). The Rust API's routes and /mcp's
// tools have their sweep in api/src/access/isolation_tests.rs; this is the other half, through the real login, the
// router and the middleware, on a server with login on. Each name and id of bo's has MARK in it, so finding MARK in a
// reply, once the ids that were sent are swapped for the ghost's, is a leak. A route added under server/api without a
// line in ROUTES fails `every route is in the table`.
//
// It runs after signup.spec.ts, whose first account (ada) is the server's owner, and asks as three people: ana, signed
// in with her own workspace; ana's agent key; and ada, the owner, who has no way into bo's workspace either.
test.describe.configure({mode: 'serial'})

const MARK = 'zephyrine'
const API = fileURLToPath(new URL('../../server/api', import.meta.url))

/** What a route is called with: `real` maps each path parameter to bo's, `ghost` to one that isn't there. */
type Ids = Record<string, string>

/** How a route is swept: with bo's ids in its path (the default) and in `body`, or not at all, saying why. */
type Line = {body?: (ids: Ids) => unknown, query?: (ids: Ids) => string} | {skip: string}

const named = (ids: Ids) => ({
    project: ids.project, projects: [ids.project], issue: ids.issue, session: ids.session, chat: ids.chat, secret: ids.name,
    name: ids.name, id: ids.id, workspace: ids.workspace, launch: ids.launch, connect: ids.connect, epic: ids.epic,
})

/** Every route of server/api, `METHOD /api/path/[param]`, and how it's swept. */
const ROUTES: Record<string, Line> = {
    'POST /api/auth/link': {skip: 'turns the asker\'s own person key into a login cookie: it names nobody else'},
    'GET /api/auth/oidc/callback': {skip: 'the login provider\'s way back, checked against the state this browser was sent with'},
    'GET /api/auth/oidc/logout': {skip: 'signs the asker out'},
    'GET /api/auth/oidc/start': {skip: 'sends the browser to the login provider'},
    'GET /api/auth/status': {},
    'POST /api/chats/[chat]/clear': {},
    'POST /api/chats/[chat]/end': {},
    'DELETE /api/chats/[chat]': {},
    'GET /api/chats/[chat]': {},
    'PATCH /api/chats/[chat]': {body: () => ({title: 'ana'})},
    'POST /api/chats/[chat]/messages': {body: () => ({text: 'hello'})},
    'POST /api/chats/[chat]/replies': {body: () => ({text: 'hello'})},
    'POST /api/chats/[chat]/requests/[message]': {body: () => ({allow: true})},
    'POST /api/chats/[chat]/requests': {body: ids => ({kind: 'issue', ...named(ids)})},
    'GET /api/chats': {},
    'POST /api/chats': {body: ids => ({project: ids.project})},
    'GET /api/connects/[connect]': {},
    'POST /api/connects/[connect]/report': {body: () => ({ok: true})},
    'POST /api/connects/[connect]/write': {body: () => ({path: 'a.txt', text: 'a'})},
    'GET /api/connects': {},
    'POST /api/connects': {body: ids => named(ids)},
    'POST /api/connects/remove': {body: ids => named(ids)},
    'GET /api/connects/stream': {},
    'POST /api/egress': {body: ids => ({url: 'https://example.com/{{secret:' + ids.name + '}}', method: 'GET', project: ids.project})},
    'POST /api/epics/[epic]/focus': {},
    'GET /api/events': {query: ids => `?patch=1&workspace=${ids.workspace}`},
    'POST /api/events/log': {body: ids => ({kind: 'test.note', message: 'ana', ...named(ids)})},
    'GET /api/guide': {},
    'GET /api/guide/using': {},
    'GET /api/launches/stream': {},
    'GET /api/machine': {},
    'POST /api/machines/claim': {body: ids => named(ids)},
    'POST /api/machines/code': {body: ids => named(ids)},
    'POST /api/machines/connect': {body: ids => named(ids)},
    'GET /api/machines/requests/[request]': {},
    'POST /api/machines/requests/[request]/approve': {},
    'GET /api/mcp': {},
    'GET /api/orrery-moves/[id]': {},
    'POST /api/orrery-moves': {body: ids => ({direction: 'send', url: 'https://example.com', key: 'k', from: ids.workspace, dry_run: true})},
    'POST /api/orrery-moves/workspaces': {skip: 'asks another orrery, at an address the body gives, for its workspaces: nothing of this one'},
    'GET /api/phone': {},
    'POST /api/phone/link': {skip: 'makes the asker a link to sign their own phone in: it names nobody else'},
    'GET /api/projects/[project]/context': {},
    'GET /api/projects/[project]/docs/[doc]/artifact': {},
    'GET /api/projects/[project]/issues/[issue]/branches': {},
    'POST /api/projects/[project]/issues/[issue]/focus': {},
    'GET /api/projects/[project]/issues/[issue]/pulls': {},
    'POST /api/projects/[project]/launches/[launch]/allow': {},
    'POST /api/projects/[project]/launches/[launch]/claim': {},
    'POST /api/projects/[project]/launches/[launch]/deny': {},
    'POST /api/projects/[project]/launches/[launch]/ended': {},
    'POST /api/projects/[project]/launches/[launch]/extend': {},
    'POST /api/projects/[project]/launches/[launch]/keys': {body: () => ({keys: 'Enter'})},
    'GET /api/projects/[project]/launches/[launch]/screen': {},
    'POST /api/projects/[project]/launches/[launch]/screen': {body: () => ({text: 'a'})},
    'POST /api/projects/[project]/launches/[launch]/stop': {},
    'POST /api/projects/[project]/launches/[launch]/stuck': {},
    'POST /api/projects/[project]/launches/[launch]/watch': {},
    'GET /api/projects/[project]/launches': {},
    'POST /api/projects/[project]/launches': {body: () => ({})},
    'POST /api/projects/[project]/launches/running': {body: () => ({})},
    'GET /api/projects/[project]/launches/stream': {},
    'GET /api/projects/[project]/listeners': {},
    'POST /api/projects/[project]/milestones/[milestone]/focus': {},
    'POST /api/projects/[project]/schedules/[schedule]/run': {},
    'GET /api/projects/[project]/sessions': {},
    'POST /api/projects/[project]/sessions/[session]/forget': {},
    'POST /api/projects/[project]/sessions/[session]/message': {body: () => ({text: 'hello'})},
    'GET /api/projects/[project]/sessions/[session]/next': {},
    'POST /api/projects/[project]/sessions/[session]/stop': {},
    'GET /api/projects/[project]/sessions/work': {},
    'POST /api/projects/[project]/signals/[signal]/delivered': {},
    'GET /api/projects/[project]/signals/stream': {},
    'POST /api/projects/upload': {query: ids => `?into=1&id=${ids.project}&key=ZEP`, body: () => ({})},
    'DELETE /api/pulls/branches': {query: ids => `?project=${ids.project}&branch=main`},
    'GET /api/pulls/branches': {query: ids => `?project=${ids.project}`},
    'GET /api/pulls': {query: ids => `?project=${ids.project}`},
    'POST /api/pulls/poll': {body: ids => named(ids)},
    'DELETE /api/secrets/[name]': {},
    'PATCH /api/secrets/[name]': {body: () => ({hosts: ['example.com']})},
    'PUT /api/secrets/[name]': {body: ids => ({value: 'ana-secret-value', hosts: ['example.com'], projects: [ids.project]})},
    'POST /api/sessions/[session]/calls': {body: () => ({tool: 'next'})},
    'GET /api/sessions': {},
    'POST /api/sessions': {body: ids => named(ids)},
    'POST /api/sessions/message': {body: ids => ({text: 'hello', ...named(ids), sessions: [ids.session]})},
    'GET /api/sessions/work': {},
    'GET /api/signals/stream': {},
    'POST /api/usage': {body: ids => named(ids)},
    'GET /api/version': {},
}

/** Every `METHOD /api/path` server/api answers, from its files as Nitro reads them. */
function everyRoute(): string[] {
    const files: string[] = []
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name)
            if (statSync(path).isDirectory()) walk(path)
            else if (name.endsWith('.ts')) files.push(relative(API, path))
        }
    }
    walk(API)
    return files.map(file => {
        const [, path, method] = /^(.*?)(?:\.(get|post|put|patch|delete))?\.ts$/.exec(file)!
        const route = `/api/${path}`.replace(/\/index$/, '').replace(/^\/api\/index$/, '/api')
        return `${(method ?? 'get').toUpperCase()} ${route}`
    })
}

test('every route is in the table', () => {
    const routes = everyRoute()
    expect(routes.length).toBeGreaterThan(80)
    expect(routes.filter(r => !(r in ROUTES)), 'a route of server/api with no line in ROUTES').toEqual([])
    expect(Object.keys(ROUTES).filter(r => !routes.includes(r)), 'a line in ROUTES with no route').toEqual([])
})

/** Signs a fresh browser in as `name` at the spec's login provider (scripts/e2e-oidc.mjs), as signup.spec.ts does. */
async function logIn(browser: Browser, baseURL: string, sub: string, name: string): Promise<Page> {
    const start = await fetch(`${baseURL}/api/auth/oidc/start`, {redirect: 'manual'})
    const provider = new URL(start.headers.get('location')!).origin
    expect((await fetch(`${provider}/next`, {method: 'POST', body: JSON.stringify({sub, name})})).ok).toBe(true)
    const page = await (await browser.newContext()).newPage()
    await page.goto('/')
    await page.getByRole('link', {name: 'Sign in or sign up'}).click()
    await expect(page).not.toHaveURL(/\/login/)
    return page
}

/** How a request is made as someone: their login's cookie, or a key. */
type Asker = {name: string, headers: Record<string, string>}

const asLogin = async (name: string, page: Page, baseURL: string): Promise<Asker> => {
    const cookies = await page.context().cookies(baseURL)
    return {name, headers: {cookie: cookies.map(c => `${c.name}=${c.value}`).join('; '), origin: baseURL}}
}

/** A route's answer, read whole, or for a stream what it sent in its first second. */
async function call(baseURL: string, asker: Asker, method: string, path: string, body?: unknown): Promise<{status: number, text: string}> {
    const stop = new AbortController()
    const timer = setTimeout(() => stop.abort(), 1500)
    let status = 0
    let text = ''
    try {
        const reply = await fetch(`${baseURL}${path}`, {
            method, signal: stop.signal, redirect: 'manual',
            headers: {...asker.headers, ...body === undefined ? {} : {'content-type': 'application/json'}},
            body: body === undefined ? undefined : JSON.stringify(body),
        })
        status = reply.status
        const reader = reply.body?.getReader()
        const decoder = new TextDecoder()
        while (reader) {
            const {done, value} = await reader.read()
            if (done) break
            text += decoder.decode(value, {stream: true})
        }
    } catch (error) {
        if ((error as Error).name !== 'AbortError') throw error
    } finally {
        clearTimeout(timer)
    }
    return {status, text}
}

/** `route` with `ids` put in for its parameters, and its query. */
function pathOf(route: string, line: Line, ids: Ids): string {
    const path = route.replace(/\[(\w+)\]/g, (_, key: string) => {
        expect(ids[key], `no id for [${key}]`).toBeTruthy()
        return encodeURIComponent(ids[key]!)
    })
    return path + ('query' in line && line.query ? line.query(ids) : '')
}

let bo: Page
let ana: Page
let ada: Page
const real: Ids = {}
const ghost: Ids = {
    project: 'ghost-board', issue: 'GHO-1', doc: '1', milestone: '1', launch: 'ghost-launch', session: 'ghost-session', signal: '1',
    schedule: '999999', chat: 'ghost-chat', message: '1', connect: 'ghost-connect', epic: '999999', name: 'GHOST_TOKEN',
    request: 'ghost-request', id: 'ghost-move', workspace: 'ghost-workspace',
}

test.afterAll(async () => {
    for (const page of [bo, ana, ada]) await page?.context().close()
})

test("bo signs up with a row of every kind in his own workspace", async ({browser, baseURL}) => {
    // A server just started compiles its pages on the first visit.
    test.setTimeout(180_000)
    // ada first: the server's owner, from signup.spec.ts, or made so here when this file runs on its own.
    ada = await logIn(browser, baseURL!, 'ada', 'Ada Lovelace')
    bo = await logIn(browser, baseURL!, `bo-${MARK}`, `Bo ${MARK}`)
    const as = await asLogin('bo', bo, baseURL!)
    const made = async (method: string, path: string, body: unknown) => {
        const reply = await call(baseURL!, as, method, path, body)
        expect(reply.status, `${method} ${path}: ${reply.text}`).toBeLessThan(300)
        return JSON.parse(reply.text || 'null')
    }
    const workspaces = await made('GET', '/api/workspaces', undefined) as {id: string, name: string}[]
    real.workspace = workspaces[0]!.id
    const project = await made('POST', '/api/projects', {name: `Rockets ${MARK}`}) as {id: string}
    real.project = project.id
    const at = `/api/projects/${real.project}`
    real.issue = (await made('POST', `${at}/issues`, {title: `Fuel ${MARK}`, notes: MARK}) as {id: string}).id
    real.doc = String((await made('POST', `${at}/docs`, {title: `Plan ${MARK}`, body: MARK}) as {id: string | number}).id)
    real.milestone = String((await made('POST', `${at}/milestones`, {title: `Liftoff ${MARK}`}) as {id: string | number}).id)
    real.epic = '7'
    real.schedule = String((await made('POST', `${at}/schedules`, {title: `Tidy ${MARK}`, cron: '0 9 * * 1'}) as {id: number}).id)
    // Epics, secrets and schedules across projects are the server owner's alone for now, so bo's epic and secret are
    // a number and a name of the shape, as below.
    real.name = `${MARK.toUpperCase()}_TOKEN`
    // No launcher runs in this suite, so bo has no launch, session, chat, signal, connect, machine request or move: those
    // are called with bo's board and an id of the shape, which the board's hold has to answer for first.
    Object.assign(real, {
        launch: `${MARK}-launch`, session: `${MARK}-session`, signal: '7', chat: `${MARK}-chat`, message: '7', connect: `${MARK}-connect`,
        request: `${MARK}-request`, id: `${MARK}-move`,
    })
    expect(Object.keys(ghost).filter(k => !(k in real))).toEqual([])
})

/** What bo sees of his own, to check after the sweep that nobody else changed it. */
async function bosView(baseURL: string): Promise<string> {
    const as = await asLogin('bo', bo, baseURL)
    const lines: string[] = []
    for (const path of [`/api/projects/${real.project}?notes=1`, '/api/epics', '/api/schedules', '/api/secrets', `/api/projects/${real.project}/docs`]) {
        const reply = await call(baseURL, as, 'GET', path)
        lines.push(`${path} ${reply.status} ${reply.text.replace(/"(updated_at|rev|read_at|last_used_at)":("[^"]*"|\d+)/g, '')}`)
    }
    return lines.join('\n')
}

const swap = (text: string) => Object.keys(real).reduce((t, key) => t.split(real[key]!).join(ghost[key]!), text)

test("nobody else reaches bo's rows through a route of the Nuxt server's own", async ({browser, baseURL}) => {
    test.setTimeout(300_000)
    ana = await logIn(browser, baseURL!, 'ana', 'Ana')
    const anaLogin = await asLogin('ana', ana, baseURL!)
    const hers = JSON.parse((await call(baseURL!, anaLogin, 'GET', '/api/workspaces')).text) as {id: string}[]
    const key = await call(baseURL!, anaLogin, 'POST', '/api/keys', {kind: 'agent', name: 'ana\'s laptop', workspace: hers[0]!.id})
    expect(key.status, key.text).toBeLessThan(300)
    const secret = (JSON.parse(key.text) as {key: string}).key
    const askers: Asker[] = [anaLogin, {name: 'ana\'s key', headers: {authorization: `Bearer ${secret}`}}, await asLogin('ada', ada, baseURL!)]

    const before = await bosView(baseURL!)
    const leaks: string[] = []
    for (const [route, line] of Object.entries(ROUTES)) {
        if ('skip' in line) continue
        const [method, template] = route.split(' ') as [string, string]
        for (const asker of askers) {
            const body = (ids: Ids) => 'body' in line && line.body ? line.body(ids) : method === 'GET' || method === 'DELETE' ? undefined : {}
            const theirs = await call(baseURL!, asker, method, pathOf(template, line, real), body(real))
            const none = await call(baseURL!, asker, method, pathOf(template, line, ghost), body(ghost))
            const said = swap(theirs.text)
            if (said.toLowerCase().includes(MARK)) leaks.push(`${asker.name}: ${route} gives away bo's: ${theirs.status} ${theirs.text.slice(0, 300)}`)
            else if (theirs.status !== none.status) leaks.push(`${asker.name}: ${route} answers bo's ${theirs.status}, none ${none.status}: ${theirs.text.slice(0, 300)}`)
        }
    }
    expect(leaks, 'what reached bo\'s workspace').toEqual([])
    expect(await bosView(baseURL!), 'bo\'s rows, after everyone else called every route with them').toBe(before)
})

test("nobody sends another workspace's secret through egress, or keeps a secret to its project", async ({baseURL}) => {
    // Only the server's owner sets secrets for now, so here ada's are the ones nobody else reaches.
    const as = await asLogin('ada', ada, baseURL!)
    const made = async (method: string, path: string, body: unknown) => {
        const reply = await call(baseURL!, as, method, path, body)
        expect(reply.status, `${method} ${path}: ${reply.text}`).toBeLessThan(300)
        return JSON.parse(reply.text || 'null')
    }
    const greenhouse = (await made('POST', '/api/projects', {name: `Greenhouse ${MARK}`}) as {id: string}).id
    const secret = `${MARK.toUpperCase()}_KEY`
    await made('PUT', `/api/secrets/${secret}`, {value: `${MARK}-value-1234`, hosts: ['example.com'], projects: [greenhouse]})
    const anaLogin = await asLogin('ana', ana, baseURL!)
    // Egress is the owner's alone for now too (secrets.egress), so ana is refused before her project is looked at; the
    // route holds the project to what she sees for when that opens up.
    const egress = (project: string, name: string) => call(baseURL!, anaLogin, 'POST', '/api/egress', {url: `https://example.com/?k={{secret:${name}}}`, project})
    const theirs = await egress(greenhouse, secret)
    const none = await egress('ghost-board', 'GHOST_KEY')
    expect(theirs.status, theirs.text).toBe(none.status)
    expect(theirs.text.toLowerCase().split(greenhouse).join('ghost-board')).not.toContain(MARK)
    // And ana keeping a secret of her own to ada's project is as for a project that isn't there.
    const kept = await call(baseURL!, anaLogin, 'PUT', '/api/secrets/ANA_KEY', {value: 'ana-value-1234', hosts: ['example.com'], projects: [greenhouse]})
    const keptNone = await call(baseURL!, anaLogin, 'PUT', '/api/secrets/ANA_KEY', {value: 'ana-value-1234', hosts: ['example.com'], projects: ['ghost-board']})
    expect(kept.status, kept.text).toBe(keptNone.status)
})
