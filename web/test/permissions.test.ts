import {existsSync, readFileSync, readdirSync} from 'node:fs'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {PERMISSIONS} from '#shared/permissions'
import type {Permission, PermissionCell} from '#shared/permissions'
import {Schedules} from '../server/utils/schedules'
import {Store} from '../server/utils/store'
import {testDb} from './db'

// The permissions table (shared/permissions.ts) against what the server does, so it can't say one thing while the code
// does another (ORR-459): each route it names is there, the chat's and an untrusted session's guards let through what
// it says and refuse the rest, and a working session meets what its column says, tried on the store or, for a rule a
// route holds, read in the code that holds it.

const me = {name: 'skoll', owner: true}
const agent = {name: 'claude', owner: false}
const allowed = (cell: PermissionCell) => cell.level === 'free' || cell.level === 'limited'

/** A route's file under server/api: `POST /api/projects/:project/issues` → projects/[project]/issues/index.post.ts. */
function routeFile(route: string): string | undefined {
    const [method, path] = route.split(' ')
    const parts = path!.replace(/^\/api\//, '').split('/').map(p => p.startsWith(':') ? `[${p.slice(1)}]` : p)
    const base = `server/api/${parts.join('/')}`
    return [`${base}.${method!.toLowerCase()}.ts`, `${base}/index.${method!.toLowerCase()}.ts`].find(f => existsSync(f))
}

/** A route as a request would ask for it. */
const concrete = (route: string) => {
    const [method, path] = route.split(' ')
    return {method: method!, path: path!.replace(/:[a-z]+/g, name => ({':project': 'greenhouse', ':issue': 'GRE-1'})[name] ?? 'x')}
}

describe('the permissions table', () => {
    it('names each thing once, with a why, and routes that exist', () => {
        expect(new Set(PERMISSIONS.map(p => p.id)).size).toBe(PERMISSIONS.length)
        for (const p of PERMISSIONS) {
            expect(p.why, p.id).toMatch(/\S/)
            for (const route of p.routes) expect(routeFile(route), `${p.id}: ${route}`).toBeDefined()
        }
    })
})

describe('the guards', () => {
    type Event = {method: string, path: string, headers: Record<string, string>}
    let untrusted: (event: Event) => Promise<void>
    let chat: (event: Event) => void

    beforeEach(async () => {
        vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
        vi.stubGlobal('forbidden', (message: string) => Object.assign(new Error(message), {statusCode: 403}))
        vi.stubGlobal('createError', (input: {statusCode: number, message: string}) => Object.assign(new Error(input.message), input))
        vi.stubGlobal('decoded', (part: string) => part)
        vi.stubGlobal('untrustedWrite', (event: Event) => event.headers['orrery-untrusted'] === 'yes')
        vi.stubGlobal('chatWrite', (event: Event) => event.headers['orrery-chat'] === 'yes')
        vi.stubGlobal('EXTERNAL', 'external')
        // The issue it comments on is one of its own proposals.
        vi.stubGlobal('useStore', () => ({issue: async () => ({proposal: 'pending', labels: ['external']})}))
        vi.resetModules()
        untrusted = (await import('../server/middleware/untrusted')).default as unknown as typeof untrusted
        chat = (await import('../server/middleware/chat')).default as unknown as typeof chat
    })

    afterEach(() => vi.unstubAllGlobals())

    /** Whether the guard lets the route through. */
    async function through(guard: (event: Event) => unknown, route: string, headers: Record<string, string>): Promise<boolean> {
        try {
            await guard({...concrete(route), headers})
            return true
        } catch (error) {
            if ((error as {statusCode?: number}).statusCode !== 403) throw error
            return false
        }
    }

    it("let an untrusted session do what its column says, and refuse it the rest", async () => {
        for (const p of PERMISSIONS) {
            const passed = await Promise.all(p.routes.map(r => through(untrusted, r, {'orrery-untrusted': 'yes'})))
            expect(passed.some(Boolean), p.id).toBe(allowed(p.untrusted))
        }
    })

    it("let the owner's chat do what its column says; what it asks for goes through its requests, never the route", async () => {
        for (const p of PERMISSIONS) {
            const passed = await Promise.all(p.routes.map(r => through(chat, r, {'orrery-chat': 'yes'})))
            expect(passed.some(Boolean), p.id).toBe(allowed(p.chat))
        }
        expect(await through(chat, 'POST /api/chats/:chat/requests', {'orrery-chat': 'yes'})).toBe(true)
    })

    it("hold each to its cell's own routes and check, and refuse a route the table doesn't name", async () => {
        const asChat = {'orrery-chat': 'yes'}
        // One issue at a time from the chat, never a bulk edit.
        expect(await through(chat, 'PATCH /api/projects/:project/issues/:issue', asChat)).toBe(true)
        expect(await through(chat, 'PATCH /api/projects/:project/issues', asChat)).toBe(false)
        expect(await through(chat, 'POST /api/somewhere/else', asChat)).toBe(false)
        // A refusal on a row's route names the row.
        await expect(chat({...concrete('POST /api/projects/:project/launches'), headers: asChat})).rejects.toMatchObject({statusCode: 403, data: {permission: 'sessions.start'}})
        // An untrusted session comments on its own external proposals only.
        vi.stubGlobal('useStore', () => ({issue: async () => ({proposal: null, labels: []})}))
        expect(await through(untrusted, 'POST /api/projects/:project/issues/:issue/comments', {'orrery-untrusted': 'yes'})).toBe(false)
        // Reads and other sessions' writes aren't its business.
        expect(await through(chat, 'GET /api/projects/:project/launches', asChat)).toBe(true)
        expect(await through(chat, 'POST /api/projects/:project/launches', {})).toBe(true)
    })
})

describe("a working session's column", () => {
    let store: Store
    let schedules: Schedules

    beforeEach(async () => {
        store = new Store(testDb(), () => {})
        await store.createProject({name: 'greenhouse', key: 'GRE'}, me)
        schedules = new Schedules(store)
    })

    /** The status a call fails with, or 200. */
    async function status(call: () => unknown): Promise<number> {
        try {
            await call()
            return 200
        } catch (error) {
            return (error as {statusCode: number}).statusCode
        }
    }

    // Each row the store or the schedules hold, tried as an agent: the level its column says, and what makes it so.
    const PROBES: Record<string, () => Promise<unknown>> = {
        'issues.create': async () => expect(await status(() => store.createIssue('greenhouse', {title: 'Shelves'}, agent))).toBe(200),
        'issues.edit': async () => {
            const plain = await store.createIssue('greenhouse', {title: 'Shelves'}, agent)
            expect(await status(() => store.updateIssue('greenhouse', plain.id, {status: 'done'}, agent))).toBe(200)
            const proposal = await store.createIssue('greenhouse', {title: 'Taller shelves', proposal: 'pending'}, agent)
            expect(await status(() => store.updateIssue('greenhouse', proposal.id, {status: 'in-progress'}, agent))).toBe(403)
        },
        'issues.delete': async () => {
            const theirs = await store.createIssue('greenhouse', {title: 'Shelves'}, me)
            const mine = await store.createIssue('greenhouse', {title: 'Lights'}, agent)
            expect(await status(() => store.deleteIssue('greenhouse', theirs.id, agent))).toBe(403)
            expect(await status(() => store.deleteIssue('greenhouse', mine.id, agent))).toBe(200)
            expect(await status(() => store.deleteProject('greenhouse', agent))).toBe(403)
        },
        'proposals.decide': async () => {
            const proposal = await store.createIssue('greenhouse', {title: 'Taller shelves', proposal: 'pending'}, agent)
            expect(await status(() => store.decide('greenhouse', proposal.id, {decision: 'approved'}, agent))).toBe(403)
        },
        'comments.write': async () => {
            const issue = await store.createIssue('greenhouse', {title: 'Shelves'}, agent)
            expect(await status(() => store.createComment('greenhouse', issue.id, {body: 'Done.', asks: 'feedback'}, agent))).toBe(200)
        },
        'docs.write': async () => expect(await status(() => store.putDoc('greenhouse', 'shelves', {title: 'Shelves', body: 'Oak.'}, agent))).toBe(200),
        'chunks.write': async () => expect((await store.createChunk('greenhouse', {title: 'Seed trays'}, agent)).title).toBe('Seed trays'),
        'presets.write': async () => expect(await status(() => store.createPreset(null, {name: 'Review', text: 'Review the PRs.'}, agent))).toBe(403),
        'prompts.write': async () => {
            expect(await status(() => store.updateProject('greenhouse', {focus_prompt: 'Do it.'}, agent))).toBe(403)
            expect(await status(() => store.updateProject('greenhouse', {description: 'Plants.'}, agent))).toBe(200)
        },
        'settings.write': async () => {
            expect(await status(() => store.updateSettings({tracker: null}, agent))).toBe(403)
            expect(await status(() => store.createStatus({name: 'Blocked', kind: 'started'}, agent))).toBe(403)
        },
        'signals.focus': async () => {
            const issue = await store.createIssue('greenhouse', {title: 'Shelves'}, agent)
            expect((await store.focus('greenhouse', issue.id, {}, agent)).protected).toBe(false)
        },
        'sessions.message': async () => expect(await status(() => store.messageSession('greenhouse', 'abc', 'Hi', agent))).toBe(403),
        'schedules.issue': async () => {
            const made = await schedules.create('greenhouse', {title: 'Weekly tidy', cron: '0 9 * * 1', ask: true}, agent)
            expect(await schedules.runNow('greenhouse', made.id, agent)).toMatchObject({outcome: 'made', note: expect.stringMatching(/didn't ask the sessions/)})
        },
        'schedules.message': async () => {
            const made = await schedules.create('greenhouse', {title: 'Nudge', kind: 'message', notes: 'Pick up Todo.', cron: '0 9 * * *'}, agent)
            expect(await schedules.runNow('greenhouse', made.id, agent)).toMatchObject({outcome: 'skipped'})
        },
        'schedules.session': async () => expect(await status(() => schedules.create('greenhouse', {title: 'Review', kind: 'session', cron: '0 9 * * *'}, agent))).toBe(403),
        'schedules.adopt': async () => {
            const made = await schedules.create('greenhouse', {title: 'Nudge', kind: 'message', notes: 'Pick up Todo.', cron: '0 9 * * *'}, agent)
            expect(await status(() => schedules.adopt('greenhouse', made.id, agent))).toBe(403)
            // An owner's change leaves it the agent's; only Make it mine takes it on.
            expect(await schedules.update('greenhouse', made.id, {title: 'Morning nudge'}, me)).toMatchObject({protected: false})
            expect(await schedules.adopt('greenhouse', made.id, me)).toMatchObject({protected: true})
        },
        'schedules.owners': async () => {
            const theirs = await schedules.create('greenhouse', {title: 'Weekly tidy', cron: '0 9 * * 1'}, me)
            expect(await status(() => schedules.update('greenhouse', theirs.id, {title: 'Tidy'}, agent))).toBe(403)
            expect(await status(() => schedules.runNow('greenhouse', theirs.id, agent))).toBe(403)
            expect(await status(() => schedules.delete('greenhouse', theirs.id, agent))).toBe(403)
            const mine = await schedules.create('greenhouse', {title: 'Lights', cron: '0 9 * * 1'}, agent)
            expect(await status(() => schedules.update('greenhouse', mine.id, {title: 'Lamps'}, agent))).toBe(200)
        },
    }

    // A rule a route or a util holds rather than the store, read where it's held.
    const HELD_IN: Record<string, [string, string][]> = {
        'secrets.write': [['server/utils/secrets.ts', 'Only the owner sets secrets']],
        'secrets.egress': [['server/utils/secrets.ts', 'may only go to']],
        'database.write': [
            ['server/utils/backup-choice.ts', 'Only the owner sets the backups'],
            ['server/utils/move.ts', 'Only the owner moves the database'],
        ],
    }

    /** Whether every route of the row asks `authorize` for it (ORR-512). */
    const authorized = (p: Permission) => p.routes.every(route => readFileSync(routeFile(route)!, 'utf8').includes(`authorize(event, '${p.id}')`))

    it('holds for every row', async () => {
        for (const p of PERMISSIONS) {
            const probe = PROBES[p.id]
            const held = HELD_IN[p.id]
            expect(probe || held || authorized(p), `${p.id} has nothing that checks it`).toBeTruthy()
            if (probe) await probe()
            for (const [file, said] of held ?? []) expect(readFileSync(file, 'utf8'), `${p.id}: ${file}`).toContain(said)
        }
    })
})

describe('authorize', () => {
    type Event = {headers: Record<string, string>}
    let authorize: (event: Event, id: string) => Promise<{name: string}>

    beforeEach(async () => {
        vi.stubGlobal('actorOf', async (event: Event) => ({name: event.headers['orrery-actor'] ?? 'agent', owner: event.headers['orrery-actor'] === 'skoll'}))
        vi.stubGlobal('chatWrite', (event: Event) => event.headers['orrery-chat'] === 'yes')
        vi.stubGlobal('untrustedWrite', (event: Event) => event.headers['orrery-untrusted'] === 'yes')
        vi.stubGlobal('createError', (input: {statusCode: number, message: string, data: unknown}) => Object.assign(new Error(input.message), input))
        vi.resetModules()
        authorize = (await import('../server/utils/authorize')).authorize as unknown as typeof authorize
    })

    afterEach(() => vi.unstubAllGlobals())

    const as = {
        owner: {'orrery-actor': 'skoll'},
        session: {'orrery-actor': 'claude'},
        // A chat or an untrusted session is what it is whatever name it gives.
        chat: {'orrery-actor': 'skoll', 'orrery-chat': 'yes'},
        untrusted: {'orrery-actor': 'skoll', 'orrery-untrusted': 'yes'},
    }

    it('lets through what each row lets each kind do, and refuses the rest with the row named', async () => {
        for (const p of PERMISSIONS) {
            expect(await authorize({headers: as.owner}, p.id)).toMatchObject({name: 'skoll'})
            for (const kind of ['session', 'chat', 'untrusted'] as const) {
                const passes = ['free', 'limited', 'owned'].includes(p[kind].level)
                const result = await authorize({headers: as[kind]}, p.id).then(() => 'passed', (error: {statusCode: number, data: {permission: string}}) => error)
                if (passes) expect(result, `${p.id}, ${kind}`).toBe('passed')
                else expect(result, `${p.id}, ${kind}`).toMatchObject({statusCode: 403, data: {permission: p.id}})
            }
        }
    })

    it('is asked only for rows the table has', () => {
        const files = (dir: string): string[] => readdirSync(dir, {withFileTypes: true}).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)])
        const ids = new Set(PERMISSIONS.map(p => p.id))
        for (const file of files('server/api')) {
            for (const [, id] of readFileSync(file, 'utf8').matchAll(/authorize\(event, '([^']+)'\)/g)) expect(ids.has(id!), `${file}: ${id}`).toBe(true)
        }
    })
})
