import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// The route a session's hook reports to (`POST /api/sessions`, channel/orrery-hook.mjs): what it passes on to `report`.
// An untrusted schedule's session, known by its launch, never has its command kept, as that could name an issue it
// would then be counted as working (ORR-583); what it does keep is capped, so a hook can't store whatever it's sent. The
// route's h3 helpers and the session utils are Nitro auto-imports, stood in for here.
type Body = Record<string, unknown>
let reported: Record<string, unknown>[]
let calls: string[]
const UNTRUSTED = 'launch-untrusted'

beforeEach(() => {
    reported = []
    calls = []
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('readBody', async (event: {body?: unknown}) => event.body)
    vi.stubGlobal('badRequest', (message: string) => Object.assign(new Error(message), {statusCode: 400}))
    vi.stubGlobal('launchUntrusted', (project: string, launch: string) => project === 'greenhouse' && launch === UNTRUSTED)
    vi.stubGlobal('report', (input: Record<string, unknown>) => {
        reported.push(input)
        return {id: input.id ?? `pid-${input.pid}`, project: input.project}
    })
    for (const name of ['considerClear', 'carryOn', 'pickWhenIdle', 'clearDone'])
        vi.stubGlobal(name, (...args: unknown[]) => void calls.push(`${name} ${args.join(' ')}`))
    vi.stubGlobal('letGo', async (...args: unknown[]) => void calls.push(`letGo ${args.join(' ')}`))
    vi.stubGlobal('resumeRun', async () => false)
    vi.stubGlobal('pickNext', async (...args: unknown[]) => void calls.push(`pickNext ${args.join(' ')}`))
    vi.stubGlobal('getRequestURL', () => new URL('http://localhost:9000/api/sessions'))
    vi.stubGlobal('useStore', () => ({}))
    vi.stubGlobal('sessionBrief', async () => undefined)
    vi.resetModules()
})

afterEach(() => vi.unstubAllGlobals())

async function hook(body: Body | null) {
    const route = (await import('../server/api/sessions/index.post')).default as unknown as (event: object) => Promise<unknown>
    return route({body})
}

describe("the hook's route", () => {
    it('refuses a report without a project, an event, or the session as id or pid', async () => {
        for (const body of [null, {event: 'Stop', id: 'abc'}, {project: 'greenhouse', id: 'abc'}, {project: 'greenhouse', event: 'Stop'}, {project: 7, event: 'Stop', id: 'abc'}])
            await expect(hook(body)).rejects.toMatchObject({statusCode: 400})
        expect(reported).toEqual([])
    })

    it("keeps an untrusted schedule's session's command out, known by its launch before its channel says so", async () => {
        await hook({project: 'greenhouse', event: 'UserPromptSubmit', id: 'abc', started: UNTRUSTED, command: 'Work on GRE-4'})
        expect(reported[0]).toMatchObject({id: 'abc', project: 'greenhouse', event: 'UserPromptSubmit'})
        expect(reported[0]!.command).toBeUndefined()
    })

    it("keeps the command of a session orrery started that isn't untrusted, and of one it didn't", async () => {
        await hook({project: 'greenhouse', event: 'UserPromptSubmit', id: 'abc', started: 'launch-trusted', command: 'Work on GRE-4'})
        await hook({project: 'greenhouse', event: 'UserPromptSubmit', id: 'def', command: 'Work on GRE-5'})
        // The same launch id on another project isn't the untrusted one.
        await hook({project: 'observatory', event: 'UserPromptSubmit', id: 'ghi', started: UNTRUSTED, command: 'Work on OBS-1'})
        expect(reported.map(r => r.command)).toEqual(['Work on GRE-4', 'Work on GRE-5', 'Work on OBS-1'])
    })

    it("caps the command at 4,000 characters, a tool's name at 200 and its detail at 300", async () => {
        await hook({project: 'greenhouse', event: 'PermissionRequest', id: 'abc', command: 'c'.repeat(5000), tool: {name: 'n'.repeat(500), detail: 'd'.repeat(1000)}})
        const [{command, tool}] = reported as [{command: string, tool: {name: string, detail: string}}]
        expect(command).toHaveLength(4000)
        expect(tool.name).toHaveLength(200)
        expect(tool.detail).toHaveLength(300)
    })

    it('takes a tool only as {name, detail?} with a name, and leaves out an empty detail', async () => {
        const tools = [{name: 'Bash', detail: ''}, {name: ''}, {detail: 'rm -rf /'}, 'Bash', ['Bash'], {name: 7}]
        for (const tool of tools) await hook({project: 'greenhouse', event: 'PreToolUse', id: 'abc', tool})
        expect(reported.map(r => r.tool)).toEqual([{name: 'Bash'}, undefined, undefined, undefined, undefined, undefined])
    })

    it('passes on only strings that say something, and the pid as a number', async () => {
        await hook({project: 'greenhouse', event: 'Stop', pid: '4242', name: '', message: 7, reason: 'done'})
        expect(reported[0]).toMatchObject({id: undefined, pid: 4242, name: undefined, message: undefined, reason: 'done'})
    })

    it('lets go of the work of a session cut off by an API error, and carries on from a plain Stop', async () => {
        await hook({project: 'greenhouse', event: 'StopFailure', id: 'abc', error: 'overloaded'})
        await hook({project: 'greenhouse', event: 'Stop', id: 'def'})
        expect(calls).toEqual(['letGo greenhouse abc overloaded', 'considerClear greenhouse abc', 'considerClear greenhouse def', 'carryOn greenhouse def', 'pickWhenIdle greenhouse def'])
    })
})
