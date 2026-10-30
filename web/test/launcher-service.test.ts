import {execFileSync, spawn} from 'node:child_process'
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it, vi} from 'vitest'
// @ts-expect-error: the launcher is plain JavaScript, run by node on the host
import {adoptable, inWsl, keepingSessions, launcherAlive, listChanges, listIn, pickUp, plist, readConfig, RELOADS, servedElsewhere, serviceProblem, skipping, systemdUnit, withProject, withoutProject, wslLocalhost} from '../../channel/launcher-service.mjs'
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

    it('reads a half-written file as none, so the running service skips it (ORR-597)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'orrery-launcher-'))
        expect(listIn(join(dir, 'none.json'))).toEqual({projects: [], pickUp: false, skip: []})
        writeFileSync(join(dir, 'half.json'), '{"projects": [{"url"')
        expect(listIn(join(dir, 'half.json'))).toBeNull()
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
