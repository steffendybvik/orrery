import {execFileSync, spawn} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it, vi} from 'vitest'
// @ts-expect-error: the launcher is plain JavaScript, run by node on the host
import {addToList, adoptable, answers, inWsl, install, installedFrom, keepingSessions, launcherAlive, listChanges, listIn, pickUp, plist, orrerysOn, projectAt, pruneList, readConfig, RELOADS, removeFromList, removeService, restartKeepsSessions, platform, servedElsewhere, serviceProblem, skipping, systemdUnit, unanswered, uninstall, withAgent, withProject, withoutProject, wslLocalhost} from '../../channel/launcher-service.mjs'
// @ts-expect-error: the same
import {follow} from '../../channel/sse.mjs'

const greenhouse = {url: 'http://localhost:9000', project: 'greenhouse', dir: '/code/greenhouse'}
const opts = {node: '/opt/homebrew/bin/node', script: '/code/orrery/channel/orrery-launcher.mjs', path: '/opt/homebrew/bin:/usr/bin', log: '/Users/me/Library/Logs/orrery-launcher.log'}

describe("the launcher's list", () => {
    it('has each project of each orrery once, in the repo it was last installed from', () => {
        let config = withProject({projects: []}, greenhouse)
        config = withProject(config, {...greenhouse, dir: '/moved/greenhouse'})
        config = withProject(config, {...greenhouse, url: 'http://localhost:9010'})
        expect(config.projects).toEqual([{...greenhouse, dir: '/moved/greenhouse'}, {...greenhouse, url: 'http://localhost:9010'}])
        expect(withoutProject(config, greenhouse).projects).toEqual([{...greenhouse, url: 'http://localhost:9010'}])
    })

    it('marks a repo Connect a repo added with when, and takes it off skip (ORR-774)', () => {
        const file = join(mkdtempSync(join(tmpdir(), 'orrery-launcher-')), 'list.json')
        writeFileSync(file, JSON.stringify({projects: [], skip: ['/code/shop']}))
        const now = new Date('2026-10-31T08:00:00.000Z')
        addToList([{url: 'http://localhost:9000', project: 'shop', dir: '/code/shop'}], '/code/shop', {file, now})
        expect(readConfig(file)).toMatchObject({projects: [{project: 'shop', dir: '/code/shop', connected_at: now.toISOString()}], skip: []})
    })

    it("takes a repo off for Remove on Connected repos, keeps it from pick-up, and lets Connect a repo put it back (ORR-1260)", () => {
        const file = join(mkdtempSync(join(tmpdir(), 'orrery-launcher-')), 'list.json')
        const shop = {url: 'http://localhost:9000', project: 'shop', dir: '/code/shop'}
        const elsewhere = {url: 'http://localhost:9010', project: 'shop', dir: '/code/shop'}
        writeFileSync(file, JSON.stringify({projects: [shop, elsewhere, greenhouse], pickUp: true, skip: []}))
        // Only this orrery's project, and only from that folder.
        expect(removeFromList([{url: shop.url, project: 'shop'}], '/code/elsewhere', {file})).toEqual([])
        expect(removeFromList([{url: shop.url, project: 'shop'}], '/code/shop', {file})).toEqual([shop])
        expect(readConfig(file)).toMatchObject({projects: [elsewhere, greenhouse], skip: ['/code/shop']})
        expect(pickUp([shop], '/code/shop', {file})).toEqual([])
        addToList([shop], '/code/shop', {file})
        expect(readConfig(file).projects.map((p: {project: string, url: string}) => `${p.url} ${p.project}`)).toContain(`${shop.url} shop`)
        expect(readConfig(file).skip).toEqual([])
    })

    it("maps a folder to its project on an orrery, the nearest repo's, and to none where that can't be told (ORR-1068)", () => {
        const file = join(mkdtempSync(join(tmpdir(), 'orrery-launcher-')), 'list.json')
        writeFileSync(file, JSON.stringify({projects: [
            greenhouse,
            {url: 'http://localhost:9010/', project: 'orrery', dir: '/code/orrery'},
            {url: 'http://localhost:9010', project: 'site', dir: '/code/orrery/site'},
            {url: 'http://localhost:9020', project: 'hub', dir: '/code/mono'},
            {url: 'http://localhost:9020', project: 'pos', dir: '/code/mono'},
        ]}))
        expect(projectAt('/code/greenhouse', 'http://localhost:9000/', {file})).toBe('greenhouse')
        expect(projectAt('/code/greenhouse/web', 'http://localhost:9000', {file})).toBe('greenhouse')
        // Another orrery's list entry for the folder isn't this one's.
        expect(projectAt('/code/greenhouse', 'http://localhost:9010', {file})).toBeUndefined()
        expect(projectAt('/code/orrery', 'http://localhost:9010', {file})).toBe('orrery')
        expect(projectAt('/code/orrery/site/pages', 'http://localhost:9010', {file})).toBe('site')
        // A folder that only starts with a repo's name isn't in it.
        expect(projectAt('/code/orrery-worktrees/orr-1', 'http://localhost:9010', {file})).toBeUndefined()
        // A monorepo serving several there: which one a call is for can't be told.
        expect(projectAt('/code/mono', 'http://localhost:9020', {file})).toBeUndefined()
        expect(projectAt('/elsewhere', 'http://localhost:9000', {file})).toBeUndefined()
        writeFileSync(file, '{')
        expect(projectAt('/code/greenhouse', 'http://localhost:9000', {file})).toBeUndefined()
    })

    it('is empty when its file is missing or broken', () => {
        const dir = mkdtempSync(join(tmpdir(), 'orrery-launcher-'))
        const none = {projects: [], pickUp: false, skip: []}
        expect(readConfig(join(dir, 'none.json'))).toEqual(none)
        writeFileSync(join(dir, 'broken.json'), '{')
        expect(readConfig(join(dir, 'broken.json'))).toEqual(none)
        writeFileSync(join(dir, 'ok.json'), JSON.stringify({projects: [greenhouse]}))
        expect(readConfig(join(dir, 'ok.json'))).toEqual({...none, projects: [greenhouse]})
    })

    it('keeps pick-up and the repos kept off it (ORR-598)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'orrery-launcher-'))
        writeFileSync(join(dir, 'on.json'), JSON.stringify({projects: [], pickUp: true, skip: ['/code/shop', 7]}))
        expect(readConfig(join(dir, 'on.json'))).toEqual({projects: [], pickUp: true, skip: ['/code/shop']})
        // Only a plain true turns it on: a list from before pick-up has none.
        writeFileSync(join(dir, 'odd.json'), JSON.stringify({projects: [], pickUp: 'yes'}))
        expect(readConfig(join(dir, 'odd.json')).pickUp).toBe(false)
    })

    it('keeps an uninstalled repo off until it is installed again (ORR-598)', () => {
        const config = {projects: [], pickUp: true, skip: ['/code/shop']}
        const off = skipping(config, '/code/greenhouse', true)
        expect(off.skip).toEqual(['/code/shop', '/code/greenhouse'])
        expect(skipping(off, '/code/greenhouse', true).skip).toEqual(['/code/shop', '/code/greenhouse'])
        expect(skipping(off, '/code/greenhouse', false).skip).toEqual(['/code/shop'])
    })

    it('keeps the agent --install --agent= named, with none for Claude Code (ORR-1075)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'orrery-launcher-'))
        writeFileSync(join(dir, 'codex.json'), JSON.stringify({projects: [], agent: 'codex'}))
        expect(readConfig(join(dir, 'codex.json')).agent).toBe('codex')
        writeFileSync(join(dir, 'odd.json'), JSON.stringify({projects: [], agent: 7}))
        expect(readConfig(join(dir, 'odd.json'))).not.toHaveProperty('agent')
        const listed = {projects: [], pickUp: true, skip: []}
        expect(withAgent(listed, 'codex')).toEqual({...listed, agent: 'codex'})
        expect(withAgent({...listed, agent: 'codex'}, undefined)).toEqual({...listed, agent: 'codex'})
        expect(withAgent({...listed, agent: 'codex'}, 'claude')).toEqual(listed)
    })

    it('reads a half-written file as none, so the running service skips it (ORR-597)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'orrery-launcher-'))
        expect(listIn(join(dir, 'none.json'))).toEqual({projects: [], pickUp: false, skip: []})
        writeFileSync(join(dir, 'half.json'), '{"projects": [{"url"')
        expect(listIn(join(dir, 'half.json'))).toBeNull()
    })
})

describe('the orrerys a launcher was installed from', () => {
    it('puts the latest first, once, as its code comes from the first (ORR-960)', () => {
        expect(installedFrom(undefined, 'http://localhost:9010/')).toEqual(['http://localhost:9010'])
        expect(installedFrom(['http://localhost:9010'], 'http://localhost:9020')).toEqual(['http://localhost:9020', 'http://localhost:9010'])
        expect(installedFrom(['http://localhost:9020', 'http://localhost:9010'], 'http://localhost:9010')).toEqual(['http://localhost:9010', 'http://localhost:9020'])
    })
})

describe('picking a repo up as its channel connects (ORR-599)', () => {
    const now = new Date('2026-10-29T20:00:00Z')
    const shop = {url: 'http://localhost:9000', project: 'shop', dir: '/code/shop'}
    const listed = (list: object) => {
        const file = join(mkdtempSync(join(tmpdir(), 'orrery-launcher-')), 'launcher.json')
        writeFileSync(file, JSON.stringify(list))
        return file
    }
    const projectsIn = (file: string) => JSON.parse(readFileSync(file, 'utf8')).projects

    it('puts the repo on the list, marked, when pick-up is on', () => {
        const file = listed({projects: [greenhouse], pickUp: true, skip: []})
        expect(pickUp([shop], '/code/shop', {file, now})).toEqual([{...shop, picked_at: now.toISOString()}])
        expect(projectsIn(file)).toEqual([greenhouse, {...shop, picked_at: now.toISOString()}])
        // Once on, it's left as it is: the line the session gets is said once.
        expect(pickUp([shop], '/code/shop', {file, now})).toEqual([])
    })

    it('leaves the list alone with pick-up off, without one, or for a repo kept off', () => {
        for (const list of [{projects: []}, {projects: [], pickUp: false}, {projects: [], pickUp: true, skip: ['/code/shop']}]) {
            const file = listed(list)
            expect(pickUp([shop], '/code/shop', {file, now})).toEqual([])
            expect(projectsIn(file)).toEqual([])
        }
        const missing = join(mkdtempSync(join(tmpdir(), 'orrery-launcher-')), 'launcher.json')
        expect(pickUp([shop], '/code/shop', {file: missing, now})).toEqual([])
    })

    it('leaves a project served from another repo there, as --install does', () => {
        const file = listed({projects: [{...shop, dir: '/code/monorepo'}], pickUp: true, skip: []})
        expect(servedElsewhere([{...shop, dir: '/code/monorepo'}], shop)).toEqual({...shop, dir: '/code/monorepo'})
        expect(pickUp([shop, {...greenhouse, dir: '/code/shop'}], '/code/shop', {file, now}).map(p => p.project)).toEqual(['greenhouse'])
        expect(projectsIn(file).map((p: {dir: string}) => p.dir)).toEqual(['/code/monorepo', '/code/shop'])
    })
})

describe('the running service following its list (ORR-597)', () => {
    const shop = {url: 'http://localhost:9000', project: 'shop', dir: '/code/shop'}

    it('serves what was added and lets go of what was taken off', () => {
        expect(listChanges([greenhouse], [greenhouse, shop])).toEqual({added: [shop], removed: []})
        expect(listChanges([greenhouse, shop], [shop])).toEqual({added: [], removed: [greenhouse]})
        expect(listChanges([greenhouse], [greenhouse])).toEqual({added: [], removed: []})
    })

    it('serves a project that moved repo from the new one', () => {
        const moved = {...greenhouse, dir: '/moved/greenhouse'}
        expect(listChanges([greenhouse], [moved])).toEqual({added: [moved], removed: [greenhouse]})
    })

    it('tells the same project on two orrerys apart', () => {
        const other = {...greenhouse, url: 'http://localhost:9010'}
        expect(listChanges([greenhouse], [greenhouse, other])).toEqual({added: [other], removed: []})
    })

    it('stops following a stream it lets go of', async () => {
        const abort = new AbortController()
        const logs: string[] = []
        const following = follow({url: () => 'http://127.0.0.1:9/never', onEvent: () => {}, log: (line: string) => logs.push(line), signal: abort.signal})
        await new Promise(resolve => setTimeout(resolve, 50))
        abort.abort()
        await expect(following).resolves.toBeUndefined()
        expect(logs.length).toBeLessThanOrEqual(1)
    })

    it('says once that nothing answers, then retries quietly (ORR-604)', async () => {
        vi.useFakeTimers()
        vi.stubGlobal('fetch', () => Promise.reject(new Error('connection refused')))
        try {
            const abort = new AbortController()
            const logs: string[] = []
            const downs: string[] = []
            const following = follow({url: () => 'http://localhost:9000/x', onEvent: () => {}, log: (line: string) => logs.push(line), down: (since: Date, error: Error) => downs.push(error.message), signal: abort.signal})
            // 1 + 2 + 4 + 8 + 16 seconds of growing waits, then 30s waits for ten minutes.
            await vi.advanceTimersByTimeAsync((1 + 2 + 4 + 8 + 16) * 1000 + 20 * 30_000)
            expect(logs).toHaveLength(5)
            expect(logs[4]).toContain('trying again in 16s')
            expect(downs).toEqual(['connection refused'])
            abort.abort()
            await following
        } finally {
            vi.unstubAllGlobals()
            vi.useRealTimers()
        }
    })
})

describe("the service's file", () => {
    it('runs the launcher for the list, with the PATH it was installed from, back if it dies', () => {
        const file = plist({...opts, path: '/a & b:/usr/bin'})
        expect(file).toContain('<string>/code/orrery/channel/orrery-launcher.mjs</string><string>--service</string>')
        expect(file).toContain('<string>/a &amp; b:/usr/bin</string>')
        // Through the bootstrap, it names the script to run too.
        const served = {...opts, script: ['/home/ada/.orrery/bootstrap.mjs', 'launcher']}
        expect(plist(served)).toContain('<string>/home/ada/.orrery/bootstrap.mjs</string><string>launcher</string><string>--service</string>')
        expect(systemdUnit(served)).toContain('"/home/ada/.orrery/bootstrap.mjs" "launcher" --service')
        expect(file).toContain('<key>SuccessfulExit</key><false/>')
        // Says it follows its list, so installing over a file without it restarts one that doesn't (ORR-597).
        expect(file).toContain(`<key>${RELOADS}</key><string>1</string>`)
        if (process.platform === 'darwin') {
            const at = join(mkdtempSync(join(tmpdir(), 'orrery-launcher-')), 'orrery.launcher.plist')
            writeFileSync(at, file)
            expect(execFileSync('plutil', ['-lint', at], {encoding: 'utf8'})).toContain('OK')
        }
        expect(systemdUnit({...opts, path: '/my "bin"'})).toContain(`ExecStart="/opt/homebrew/bin/node" "/code/orrery/channel/orrery-launcher.mjs" --service\nEnvironment="${RELOADS}=1"\nEnvironment="PATH=/my \\"bin\\""\nRestart=on-failure`)
        // Inside WSL, the distro it was installed from, for Watch.
        expect(systemdUnit({...opts, distro: 'Ubuntu'})).toContain('Environment="PATH=/opt/homebrew/bin:/usr/bin"\nEnvironment="WSL_DISTRO_NAME=Ubuntu"\nRestart=on-failure')
    })
})

describe('its sessions when the service restarts itself (ORR-686)', () => {
    const opts = {node: '/opt/homebrew/bin/node', script: '/code/orrery/channel/orrery-launcher.mjs', path: '/usr/bin'}

    it("has systemd leave them, as it would kill the tmux server they run in", () => {
        expect(systemdUnit(opts)).toContain('[Service]\nKillMode=process\nExecStart=')
    })

    it('brings an older unit up to what installing would write, so that restarts nothing', () => {
        const unit = systemdUnit(opts)
        expect(keepingSessions(unit.replace('KillMode=process\n', ''))).toBe(unit)
        expect(keepingSessions(unit)).toBe(unit)
    })
})

describe('where the service installs (ORR-576)', () => {
    it('knows WSL by its variables or its kernel', () => {
        expect(inWsl({env: {WSL_DISTRO_NAME: 'Ubuntu'}, kernel: () => ''})).toBe(true)
        expect(inWsl({env: {}, kernel: () => 'Linux version 5.15.153.1-microsoft-standard-WSL2'})).toBe(true)
        expect(inWsl({env: {}, kernel: () => 'Linux version 6.8.0-45-generic'})).toBe(false)
        expect(inWsl({env: {}, kernel: () => { throw new Error('no /proc') }})).toBe(false)
    })

    it('installs on macOS, and on Linux or WSL with systemd', () => {
        expect(serviceProblem({platform: 'darwin'})).toBeNull()
        expect(serviceProblem({platform: 'linux', wsl: false, systemd: true})).toBeNull()
        expect(serviceProblem({platform: 'linux', wsl: true, systemd: true})).toBeNull()
    })

    it('says what to do where it can\'t', () => {
        expect(serviceProblem({platform: 'win32'})).toMatch(/inside WSL/)
        expect(serviceProblem({platform: 'linux', wsl: true, systemd: false})).toMatch(/systemd=true.*wsl\.conf.*wsl --shutdown/)
        expect(serviceProblem({platform: 'linux', wsl: false, systemd: false})).toMatch(/run it in a terminal/)
        expect(serviceProblem({platform: 'freebsd'})).toMatch(/macOS and Linux only, not freebsd/)
    })

    it("takes an address on this machine for one WSL's localhost may not reach", () => {
        for (const url of ['http://localhost:9000', 'http://127.0.0.1', 'http://[::1]:9000/']) expect(wslLocalhost(url)).toBe(true)
        for (const url of ['http://localhost.example.com', 'http://192.168.1.4:9000', 'https://orrery.example.com']) expect(wslLocalhost(url)).toBe(false)
    })
})

describe('taking over a running session', () => {
    const alive = (pid: number) => pid === 4242

    it("leaves a session to the launcher that runs it while that one lives", () => {
        expect(adoptable('4242', 100, alive)).toBe(false)
    })

    it('takes it once that launcher is gone, or it was its own, or no launcher was kept', () => {
        expect(adoptable('5151', 100, alive)).toBe(true)
        expect(adoptable('100', 100, alive)).toBe(true)
        expect(adoptable('', 100, alive)).toBe(true)
        expect(adoptable('not a pid', 100, alive)).toBe(true)
    })

    it('sees a running launcher as alive, and not a pid now running something else', () => {
        const launcher = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)', '/orrery/channel/orrery-launcher.mjs'])
        try {
            expect(launcherAlive(launcher.pid)).toBe(true)
        } finally {
            launcher.kill()
        }
        const served = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)', '/home/ada/.orrery/bootstrap.mjs', 'launcher', '--service'])
        try {
            expect(launcherAlive(served.pid)).toBe(true)
        } finally {
            served.kill()
        }
        expect(launcherAlive(process.pid)).toBe(false)
    })
})

describe('orrerys on the list that have gone (ORR-1316)', () => {
    const listed = () => {
        const file = join(mkdtempSync(join(tmpdir(), 'orrery-prune-')), 'launcher.json')
        writeFileSync(file, JSON.stringify({
            projects: [
                {url: 'https://orrery.example.com', project: 'shop', dir: '/apps'},
                {url: 'http://localhost:9010', project: 'shop', dir: '/apps/shop'},
                {url: 'http://localhost:9020', project: 'hub', dir: '/work/hub'},
            ],
            pickUp: true, skip: ['/old'], orreries: ['http://localhost:9010', 'https://orrery.example.com'], agent: 'claude',
        }))
        return file
    }

    it('names each orrery once, its projects\' and those it follows', () => {
        expect(orrerysOn(readConfig(listed()))).toEqual(['https://orrery.example.com', 'http://localhost:9010', 'http://localhost:9020'])
    })

    it('finds those nothing answers at, a refusal counting as an answer', async () => {
        const answer = async (url: string) => url.startsWith('https://')
        expect(await unanswered(readConfig(listed()), {answer})).toEqual(['http://localhost:9010', 'http://localhost:9020'])
        expect(await answers('https://orrery.example.com/', {fetcher: async () => new Response('', {status: 401})})).toBe(true)
        expect(await answers('http://localhost:9010', {fetcher: async () => { throw new TypeError('fetch failed') }})).toBe(false)
    })

    it("takes their projects off, and them off the orrerys it follows, keeping the rest of the list", () => {
        const file = listed()
        const off = pruneList(['http://localhost:9010', 'http://localhost:9020'], {file})
        expect(off.map(p => `${p.project} ${p.url}`)).toEqual(['shop http://localhost:9010', 'hub http://localhost:9020'])
        expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
            projects: [{url: 'https://orrery.example.com', project: 'shop', dir: '/apps'}],
            pickUp: true, skip: ['/old'], orreries: ['https://orrery.example.com'], agent: 'claude',
        })
        // Nothing more to take off, so the file isn't written again.
        expect(pruneList(['http://localhost:9010'], {file})).toEqual([])
    })
})

describe('installing and removing the service (ORR-1312)', () => {
    const script = '/code/orrery/channel/orrery-launcher.mjs'
    const line = {node: '/opt/homebrew/bin/node', script, path: '/opt/homebrew/bin:/usr/bin'}
    const shop = {url: 'http://localhost:9000', project: 'shop', dir: '/code/shop'}

    /** A machine in a temporary home whose commands only get written down: `answer` says what each gives back,
     * throwing for one that fails. */
    function machine(os: string, answer: (command: string) => string = () => '', env: Record<string, string> = {}) {
        const home = mkdtempSync(join(tmpdir(), 'orrery-home-'))
        const ran: string[] = []
        const paused: number[] = []
        const run = (...args: string[]) => {
            const command = args.join(' ')
            ran.push(command)
            return answer(command)
        }
        return {ran, paused, home, machine: {os, home, env, uid: 501, run, pause: (ms: number) => paused.push(ms), problem: null}}
    }
    const listOf = (home: string) => JSON.parse(readFileSync(join(home, '.config', 'orrery', 'launcher.json'), 'utf8'))

    it('writes the plist on macOS and boots it in, trying again while the old one is still going', () => {
        let bootstraps = 0
        const mac = machine('darwin', command => {
            if (command.startsWith('launchctl bootout')) throw new Error('Boot-out failed: 3: No such process')
            if (command.startsWith('launchctl bootstrap') && ++bootstraps < 3) throw new Error('Bootstrap failed: 5: Input/output error')
            return ''
        })
        const done = install([shop], {...line, dir: '/code/shop', orrery: 'http://localhost:9000/', machine: mac.machine})
        const file = join(mac.home, 'Library', 'LaunchAgents', 'orrery.launcher.plist')
        const log = join(mac.home, 'Library', 'Logs', 'orrery-launcher.log')
        expect(done).toMatchObject({file, logs: log, restarted: true})
        expect(readFileSync(file, 'utf8')).toBe(plist({...line, log}))
        expect(mac.ran).toEqual([
            'launchctl bootout gui/501/orrery.launcher',
            'launchctl bootstrap gui/501 ' + file,
            'launchctl bootstrap gui/501 ' + file,
            'launchctl bootstrap gui/501 ' + file,
        ])
        expect(mac.paused).toEqual([500, 500])
        expect(listOf(mac.home)).toEqual({projects: [shop], pickUp: true, skip: [], orreries: ['http://localhost:9000']})
    })

    it('gives up booting it in after ten tries, saying why', () => {
        const mac = machine('darwin', command => {
            if (command.startsWith('launchctl bootstrap')) throw new Error('Bootstrap failed: 5: Input/output error')
            return ''
        })
        expect(() => install([], {...line, machine: mac.machine})).toThrow('Bootstrap failed: 5')
        expect(mac.ran.filter(c => c.startsWith('launchctl bootstrap'))).toHaveLength(10)
        expect(mac.paused).toHaveLength(9)
    })

    it('leaves a running service on the same file alone, and starts one that has stopped', () => {
        let state = 'state = running'
        const mac = machine('darwin', command => {
            if (command.startsWith('launchctl print')) return `gui/501/orrery.launcher = {\n\t${state}\n}`
            return ''
        })
        install([shop], {...line, dir: '/code/shop', machine: mac.machine})
        mac.ran.length = 0
        const again = install([{...shop, project: 'hub'}], {...line, dir: '/code/shop', machine: mac.machine})
        expect(again.restarted).toBe(false)
        expect(mac.ran).toEqual(['launchctl print gui/501/orrery.launcher'])
        // Only the list changed, which the running service follows.
        expect(listOf(mac.home).projects.map((p: {project: string}) => p.project)).toEqual(['shop', 'hub'])
        state = 'state = not running'
        mac.ran.length = 0
        expect(install([], {...line, machine: mac.machine}).restarted).toBe(true)
        expect(mac.ran.slice(1)).toEqual(['launchctl bootout gui/501/orrery.launcher', `launchctl bootstrap gui/501 ${join(mac.home, 'Library', 'LaunchAgents', 'orrery.launcher.plist')}`])
    })

    it('writes the systemd unit on Linux, in its own config folder, and enables and restarts it', () => {
        const linux = machine('linux', () => '', {WSL_DISTRO_NAME: 'Ubuntu'})
        const done = install([shop], {...line, dir: '/code/shop', pickUp: false, agent: 'codex', machine: linux.machine})
        const file = join(linux.home, '.config', 'systemd', 'user', 'orrery-launcher.service')
        expect(done).toMatchObject({file, logs: 'journalctl --user -u orrery-launcher -f', restarted: true})
        expect(readFileSync(file, 'utf8')).toBe(systemdUnit({...line, distro: 'Ubuntu'}))
        expect(linux.ran).toEqual(['systemctl --user daemon-reload', 'systemctl --user enable orrery-launcher', 'systemctl --user restart orrery-launcher'])
        expect(listOf(linux.home)).toEqual({projects: [shop], pickUp: false, skip: [], agent: 'codex'})
        // XDG_CONFIG_HOME moves the unit and the list with it.
        const xdg = machine('linux')
        const config = join(xdg.home, 'config')
        install([], {...line, machine: {...xdg.machine, env: {XDG_CONFIG_HOME: config}}})
        expect(existsSync(join(config, 'systemd', 'user', 'orrery-launcher.service'))).toBe(true)
        expect(existsSync(join(config, 'orrery', 'launcher.json'))).toBe(true)
    })

    it('installs nothing where the service has no home, saying what to do', () => {
        const linux = machine('linux')
        expect(() => install([shop], {...line, machine: {...linux.machine, problem: serviceProblem({platform: 'linux', wsl: true, systemd: false})}})).toThrow(/systemd=true/)
        expect(linux.ran).toEqual([])
        expect(existsSync(join(linux.home, '.config'))).toBe(false)
    })

    it('keeps the service on uninstall while pick-up is on, keeping the repo off the list', () => {
        const linux = machine('linux', command => command.endsWith('is-active orrery-launcher') ? 'active' : '')
        install([shop], {...line, dir: '/code/shop', machine: linux.machine})
        linux.ran.length = 0
        const {config, file} = uninstall([shop], {...line, dir: '/code/shop', machine: linux.machine})
        expect(config).toMatchObject({projects: [], pickUp: true, skip: ['/code/shop']})
        expect(linux.ran).toEqual(['systemctl --user is-active orrery-launcher'])
        expect(existsSync(file)).toBe(true)
    })

    it('removes the service with the last project when pick-up is off, keeping the list', () => {
        const linux = machine('linux')
        install([shop], {...line, dir: '/code/shop', pickUp: false, machine: linux.machine})
        linux.ran.length = 0
        const {file} = uninstall([shop], {...line, dir: '/code/shop', machine: linux.machine})
        expect(linux.ran).toEqual(['systemctl --user disable --now orrery-launcher'])
        expect(existsSync(file)).toBe(false)
        expect(listOf(linux.home)).toEqual({projects: [], pickUp: false, skip: ['/code/shop']})
    })

    it('removes the service whatever is on the list, one that was not running too, and turns pick-up off', () => {
        const mac = machine('darwin', command => {
            if (command.startsWith('launchctl bootout')) throw new Error('Boot-out failed: 3: No such process')
            return ''
        })
        install([shop], {...line, dir: '/code/shop', machine: mac.machine})
        mac.ran.length = 0
        const {file} = removeService(platform(mac.machine))
        expect(mac.ran).toEqual(['launchctl bootout gui/501/orrery.launcher'])
        expect(existsSync(file)).toBe(false)
        expect(listOf(mac.home)).toEqual({projects: [shop], pickUp: false, skip: []})
    })

    it("brings an older unit up to keeping its sessions, with no restart (ORR-686)", () => {
        expect(restartKeepsSessions(machine('darwin').machine)).toBe(true)
        const linux = machine('linux')
        // No unit at all: nothing to keep them.
        expect(restartKeepsSessions(linux.machine)).toBe(false)
        const file = join(linux.home, '.config', 'systemd', 'user', 'orrery-launcher.service')
        const unit = systemdUnit(line)
        mkdirSync(join(linux.home, '.config', 'systemd', 'user'), {recursive: true})
        writeFileSync(file, unit.replace('KillMode=process\n', ''))
        expect(restartKeepsSessions(linux.machine)).toBe(true)
        expect(readFileSync(file, 'utf8')).toBe(unit)
        expect(linux.ran).toEqual(['systemctl --user daemon-reload'])
        // Up to date already: nothing to reload.
        expect(restartKeepsSessions(linux.machine)).toBe(true)
        expect(linux.ran).toHaveLength(1)
    })
})
