import {createHash} from 'node:crypto'
import {execFile} from 'node:child_process'
import {existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync} from 'node:fs'
import {createServer, type Server} from 'node:http'
import type {AddressInfo} from 'node:net'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {newer, orreriesFor, resolve, servable} from '../../channel/bootstrap.mjs'

// The bootstrap (ORR-435): what it fetches, from where, what it runs when it can't, and that a real run gets to the
// script with its own flags, against a small server standing in for an orrery.
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const bootstrap = fileURLToPath(new URL('../../channel/bootstrap.mjs', import.meta.url))

type Served = {id?: string, version?: string, code?: string, script?: string, listed?: string, status?: number, redirect?: string}

function serve(state: {now: Served}) {
    return createServer((request, response) => {
        const {id = 'orr1', version = '1.0.0', code = 'aaaa', script = 'console.log("v1", process.argv.slice(2).join(" "), process.env.ORRERY_CODE)', listed, status, redirect} = state.now
        if (redirect) {
            response.writeHead(302, {Location: redirect}).end()
        } else if (status) {
            response.writeHead(status).end()
        } else if (request.url === '/channel/manifest.json') {
            const files = Object.fromEntries(['orrery-channel.mjs', 'orrery-hook.mjs', 'orrery-launcher.mjs'].map(name => [name, listed ?? sha256(script)]))
            response.end(JSON.stringify({id, version, code, files}))
        } else {
            response.end(script)
        }
    })
}

describe('the bootstrap', () => {
    let home: string
    let server: Server
    let url: string
    const state: {now: Served} = {now: {}}
    const env = () => ({ORRERY_URL: url, ORRERY_ID: 'orr1'}) as NodeJS.ProcessEnv

    beforeEach(async () => {
        home = mkdtempSync(join(tmpdir(), 'orrery-bootstrap-'))
        state.now = {}
        server = serve(state)
        await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    })
    afterEach(() => server.close())

    it('fetches only from this machine or https', () => {
        for (const good of ['http://localhost:9000', 'http://127.0.0.1:9000', 'http://[::1]:9000', 'https://orrery.example.com']) expect(servable(good)).toBe(true)
        for (const bad of ['http://192.168.1.5:9000', 'http://localhost.evil.com', 'http://127.0.0.1.evil.com', 'ftp://localhost', 'file:///x', 'nonsense']) expect(servable(bad)).toBe(false)
    })

    it('orders versions, a candidate before its release', () => {
        expect(newer('1.0.0-rc.14', '1.0.0-rc.9')).toBe(true)
        expect(newer('1.0.0-rc.9', '1.0.0-rc.14')).toBe(false)
        expect(newer('1.0.0', '1.0.0-rc.14')).toBe(true)
        expect(newer('1.0.1', '1.0.0')).toBe(true)
        expect(newer('1.0.0', '1.0.0')).toBe(false)
    })

    it('keeps a copy it checked, and uses it while the code is the same', async () => {
        const copy = await resolve('channel', {env: env(), home})
        expect(copy).toMatchObject({version: '1.0.0', code: 'aaaa', from: url})
        expect(readFileSync(copy.path!, 'utf8')).toContain('v1')
        state.now = {script: 'changed but listed under the same code'}
        expect((await resolve('channel', {env: env(), home})).path).toBe(copy.path)
    })

    it('moves to new code, and removes the old copy', async () => {
        const first = await resolve('channel', {env: env(), home})
        state.now = {version: '1.0.1', code: 'bbbb', script: 'console.log("v2")'}
        const next = await resolve('channel', {env: env(), home})
        expect(next.version).toBe('1.0.1')
        expect(readFileSync(next.path!, 'utf8')).toContain('v2')
        expect(existsSync(first.path!)).toBe(false)
    })

    it('runs the last good copy when the orrery is down, a file comes cut short, or a redirect answers', async () => {
        const good = await resolve('channel', {env: env(), home})
        state.now = {version: '1.0.1', code: 'bbbb', listed: sha256('something else')}
        const cut = await resolve('channel', {env: env(), home})
        expect(cut).toMatchObject({path: good.path, code: 'aaaa'})
        expect(cut.problem).toContain("isn't the file")
        state.now = {redirect: 'http://192.168.1.5/channel/manifest.json'}
        const moved = await resolve('channel', {env: env(), home})
        expect(moved.path).toBe(good.path)
        expect(moved.problem).toBeTruthy()
        state.now = {status: 500}
        expect((await resolve('channel', {env: env(), home})).path).toBe(good.path)
    })

    it('runs nothing from another orrery, or one it may not fetch from, and says why', async () => {
        state.now = {id: 'someone-else'}
        const other = await resolve('channel', {env: env(), home})
        expect(other.path).toBeUndefined()
        expect(other.problem).toContain('is someone-else, not orr1')
        const far = await resolve('channel', {env: {ORRERY_URL: 'http://192.168.1.5:9000'} as NodeJS.ProcessEnv, home})
        expect(far.path).toBeUndefined()
        expect(far.problem).toContain("isn't on this machine or https")
    })

    it('has a hook look at most once a minute', async () => {
        const now = 1_000_000
        const first = await resolve('hook', {env: env(), home, now})
        state.now = {version: '1.0.1', code: 'bbbb', script: 'new'}
        expect((await resolve('hook', {env: env(), home, now: now + 30_000})).code).toBe('aaaa')
        expect((await resolve('hook', {env: env(), home, now: now + 61_000})).code).toBe('bbbb')
        expect(first.code).toBe('aaaa')
    })

    it('has a hook skip the network for a minute after a failed look too', async () => {
        const now = 1_000_000
        await resolve('hook', {env: env(), home, now})
        let asked = 0
        const fetch = (async () => { asked++; throw new Error('down') }) as typeof globalThis.fetch
        await resolve('hook', {env: env(), home, now: now + 61_000, fetch})
        await resolve('hook', {env: env(), home, now: now + 62_000, fetch})
        expect(asked).toBe(1)
    })

    /** A launcher's list in a config folder of its own, and the environment that points at it. */
    async function listed(list: object) {
        const config = join(home, 'config')
        const {mkdirSync} = await import('node:fs')
        mkdirSync(join(config, 'orrery'), {recursive: true})
        writeFileSync(join(config, 'orrery', 'launcher.json'), JSON.stringify(list))
        return {XDG_CONFIG_HOME: config, ORRERY_HOME: join(home, '.orrery')} as NodeJS.ProcessEnv
    }

    it('takes a launcher\'s code from one orrery, never the newest on its list (ORR-960)', async () => {
        // Another orrery on the list, which says it runs a much newer version and serves other code.
        const loud = createServer((request, response) => {
            if (request.url === '/channel/manifest.json') response.end(JSON.stringify({id: 'theirs', version: '99.0.0', code: 'eeee', files: {'orrery-launcher.mjs': sha256('evil')}}))
            else response.end('evil')
        })
        await new Promise<void>(done => loud.listen(0, '127.0.0.1', done))
        const loudUrl = `http://127.0.0.1:${(loud.address() as AddressInfo).port}`
        try {
            // Installed from `url`, with the other one added later, by pick-up or Connect a repo.
            const listEnv = await listed({orreries: [`${url}/`], projects: [{url: loudUrl, project: 'a'}, {url, project: 'b'}]})
            expect(orreriesFor('launcher', listEnv, home)).toEqual([url])
            expect(await resolve('launcher', {env: listEnv, home})).toMatchObject({version: '1.0.0', code: 'aaaa', from: url})
        } finally {
            loud.close()
        }
    })

    it('names a launcher\'s orrery where it\'s run, else where it was installed from, its copy came from, or the list starts', async () => {
        const other = 'http://localhost:9020'
        expect(orreriesFor('launcher', {...await listed({orreries: [url], projects: [{url: other, project: 'a'}]}), ORRERY_URL: `${other}/`}, home)).toEqual([other])
        expect(orreriesFor('launcher', await listed({orreries: [url, other], projects: [{url: other, project: 'a'}]}), home)).toEqual([url])
        // An older list, with no `orreries`: the orrery its copy came from stays its source.
        const env = await listed({projects: [{url: other, project: 'a'}, {url, project: 'b'}]})
        expect(orreriesFor('launcher', env, home)).toEqual([other])
        const {mkdirSync} = await import('node:fs')
        mkdirSync(join(home, '.orrery', 'launcher'), {recursive: true})
        writeFileSync(join(home, '.orrery', 'launcher', 'current-launcher.json'), JSON.stringify({folder: 'x', from: url}))
        expect(orreriesFor('launcher', env, home)).toEqual([url])
        expect(orreriesFor('launcher', await listed({}), home)).toEqual([url])
        expect(orreriesFor('launcher', {XDG_CONFIG_HOME: join(home, 'nowhere'), ORRERY_HOME: join(home, 'nowhere')} as NodeJS.ProcessEnv, home)).toEqual(['http://localhost:9000'])
    })

    const run = (args: string[], extra: Record<string, string>) => new Promise<{code: number, stdout: string, stderr: string}>(done => {
        execFile(process.execPath, [bootstrap, ...args], {env: {...process.env, HOME: home, ORRERY_HOME: join(home, '.orrery'), ...extra}}, (error, stdout, stderr) =>
            done({code: error ? Number(error.code) : 0, stdout, stderr}))
    })

    it('runs the script with its own flags', async () => {
        const {code, stdout} = await run(['launcher', '--list'], {ORRERY_URL: url})
        expect(code).toBe(0)
        expect(stdout.trim()).toBe('v1 --list aaaa')
        expect(readdirSync(join(home, '.orrery'))).toContain('launcher')
    })

    it('fails a channel with why, and never a hook', async () => {
        const channel = await run(['channel'], {ORRERY_URL: 'http://192.168.1.5:9000'})
        expect(channel.code).toBe(1)
        expect(channel.stderr).toContain("isn't on this machine or https")
        const hook = await run(['hook'], {ORRERY_URL: 'http://192.168.1.5:9000'})
        expect(hook.code).toBe(0)
        expect(hook.stdout).toBe('')
        expect((await run(['nothing'], {})).code).toBe(1)
    })
})
