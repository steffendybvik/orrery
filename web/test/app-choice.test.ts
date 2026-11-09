import {execFile} from 'node:child_process'
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs'
import {createServer, type Server} from 'node:http'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {afterEach, describe, expect, it} from 'vitest'
// @ts-expect-error: plain JavaScript, no types
import {appNamed, appsHere, askToChoose, choiceFor, choseOther, readChoice, writeChoice} from '../../channel/app-choice.mjs'

// A `claude` opened by hand in a folder no orrery knows, with two orrerys set up on the machine (ORR-1080): its first
// orrery call asks which, `choose_app` records it, the other orrery refuses, and the hook reports to the chosen one only.
const PERSONAL = {name: 'orrery-personal', id: 'orr_personal', url: 'http://127.0.0.1:1'}
const WORK = {name: 'orrery-work', id: 'orr_work', url: 'http://127.0.0.1:2'}
const SESSION = 'b6a2c0de-1111-4222-8333-944455556666'

/** A machine: Claude Code's config with both orrerys' user-level servers, and orrery's own config folder. */
function machine(apps = [PERSONAL, WORK]) {
    const root = mkdtempSync(join(tmpdir(), 'orrery-choice-'))
    const claude = join(root, 'claude')
    mkdirSync(claude, {recursive: true})
    writeFileSync(join(claude, '.claude.json'), JSON.stringify({mcpServers: Object.fromEntries(apps.map(app =>
        [app.name, {type: 'stdio', command: 'node', env: {ORRERY_URL: app.url, ORRERY_ID: app.id, ORRERY_PROJECTS: '*', ORRERY_SCOPE: 'user'}}]))}))
    return {root, claude, files: {settings: join(claude, 'settings.json'), state: join(claude, '.claude.json')}, env: {XDG_CONFIG_HOME: join(root, 'config'), CLAUDE_CONFIG_DIR: claude}}
}

const userEnv = (at: ReturnType<typeof machine>, app: typeof PERSONAL) => ({...at.env, ORRERY_SCOPE: 'user', ORRERY_ID: app.id, ORRERY_URL: app.url, CLAUDE_CODE_SESSION_ID: SESSION})

describe('choosing the orrery a hand-opened session uses', () => {
    it('lists the orrerys set up on this machine', () => {
        const at = machine()
        expect(appsHere(at.files)).toEqual([PERSONAL, WORK])
        expect(appNamed([PERSONAL, WORK], 'work')).toEqual(WORK)
        expect(appNamed([PERSONAL, WORK], 'orrery-personal')).toEqual(PERSONAL)
        expect(appNamed([PERSONAL, WORK], 'http://127.0.0.1:2/')).toEqual(WORK)
        expect(appNamed([PERSONAL, WORK], 'nope')).toBeUndefined()
    })

    it('asks before the first call, then serves the chosen orrery and refuses from the other', () => {
        const at = machine()
        const apps = appsHere(at.files)
        const personal = userEnv(at, PERSONAL)
        const work = userEnv(at, WORK)
        expect(choiceFor({env: personal, apps})).toEqual({state: 'unchosen', apps})
        expect(choiceFor({env: work, apps}).state).toBe('unchosen')
        expect(askToChoose(apps)).toContain('orrery-personal at http://127.0.0.1:1; orrery-work at http://127.0.0.1:2')

        writeChoice(SESSION, {id: WORK.id, url: WORK.url, environment: 'work', project: 'hub'}, personal)
        expect(choiceFor({env: work, apps})).toEqual({state: 'mine', project: 'hub'})
        const other = choiceFor({env: personal, apps})
        expect(other.state).toBe('other')
        expect(choseOther(other.choice)).toContain('chose work (http://127.0.0.1:2)')
        // Another session in the same folder hasn't chosen.
        expect(choiceFor({env: {...personal, CLAUDE_CODE_SESSION_ID: 'another'}, apps}).state).toBe('unchosen')
    })

    it("leaves alone what isn't a hand-opened session in an unlinked folder with several orrerys", () => {
        const at = machine()
        const apps = appsHere(at.files)
        const env = userEnv(at, PERSONAL)
        expect(choiceFor({env, apps, linked: true}).state).toBe('free')
        expect(choiceFor({env: {...env, ORRERY_STARTED: 'launch-1'}, apps}).state).toBe('free')
        expect(choiceFor({env: {...env, ORRERY_SCOPE: undefined}, apps}).state).toBe('free')
        expect(choiceFor({env, apps: [PERSONAL]}).state).toBe('free')
    })

    it("keeps no choice for a session id that can't be a file name", () => {
        const at = machine()
        expect(() => writeChoice('../escape', {id: WORK.id, url: WORK.url}, at.env)).toThrow("Claude id isn't known")
        expect(() => writeChoice(undefined, {id: WORK.id, url: WORK.url}, at.env)).toThrow()
        expect(readChoice('../escape', at.env)).toBeUndefined()
    })
})

describe("the user-level hooks after a choice", () => {
    const servers: Server[] = []
    afterEach(() => servers.splice(0).forEach(s => s.close()))

    /** An orrery that only takes the hook's reports. */
    async function orrery() {
        const reports: {project: string, event: string}[] = []
        const server = createServer((req, res) => {
            let body = ''
            req.on('data', chunk => body += chunk)
            req.on('end', () => {
                if (req.url === '/api/sessions') reports.push(JSON.parse(body))
                res.setHeader('Content-Type', 'application/json')
                res.end('{}')
            })
        })
        servers.push(server)
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        const {port} = server.address() as {port: number}
        return {url: `http://127.0.0.1:${port}`, reports}
    }

    const hookAt = fileURLToPath(new URL('../../channel/orrery-hook.mjs', import.meta.url))
    const runHook = (env: Record<string, string | undefined>, input: object) => new Promise<void>((resolve, reject) => {
        const child = execFile(process.execPath, [hookAt], {env: {PATH: process.env.PATH, HOME: env.XDG_CONFIG_HOME, ...env}}, error => error ? reject(error) : resolve())
        child.stdin!.end(JSON.stringify(input))
    })

    it('reports to the chosen orrery only, and to neither before a choice', async () => {
        const [personal, work] = [await orrery(), await orrery()]
        const at = machine([{...PERSONAL, url: personal.url}, {...WORK, url: work.url}])
        const folder = mkdtempSync(join(tmpdir(), 'orrery-unlinked-'))
        const input = {session_id: SESSION, cwd: folder, hook_event_name: 'UserPromptSubmit', prompt: 'hello'}
        const both = () => Promise.all([
            runHook({...userEnv(at, {...PERSONAL, url: personal.url}), CLAUDE_PROJECT_DIR: folder}, input),
            runHook({...userEnv(at, {...WORK, url: work.url}), CLAUDE_PROJECT_DIR: folder}, input),
        ])

        await both()
        expect([personal.reports, work.reports]).toEqual([[], []])

        writeChoice(SESSION, {id: WORK.id, url: work.url, environment: 'work', project: 'hub'}, at.env)
        await both()
        expect(personal.reports).toEqual([])
        expect(work.reports).toEqual([expect.objectContaining({project: 'hub', event: 'UserPromptSubmit', id: SESSION})])
    })
})
