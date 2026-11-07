import {execFileSync, spawn} from 'node:child_process'
import {mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs'
import {createServer} from 'node:http'
import type {AddressInfo} from 'node:net'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'
// @ts-expect-error: plain JavaScript, no types
import {githubName, repoContext, repoOf} from '../../channel/repo-context.mjs'

// Which repo a session is in (ORR-1070): what the hook adds to its context on `SessionStart`, and the launcher to the
// system prompt of a session it starts. Read off a real git repo, made here.
const HOOK = new URL('../../channel/orrery-hook.mjs', import.meta.url).pathname
const folder = () => realpathSync(mkdtempSync(join(tmpdir(), 'orrery-repo-context-')))
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], {stdio: 'ignore'})

/** A repo on branch `feat/x`, with an `origin` whose default branch is `main`. */
function repo() {
    const dir = folder()
    git(dir, 'init', '-q', '-b', 'main')
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'first')
    git(dir, 'remote', 'add', 'origin', 'git@github.com:Hati/Greenhouse.git')
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    git(dir, 'switch', '-q', '-c', 'feat/x')
    return dir
}

describe('which repo a session is told it is in', () => {
    it('reads the path, origin, branch and default branch off git', () => {
        const dir = repo()
        expect(repoOf(dir)).toMatchObject({path: dir, origin: 'git@github.com:Hati/Greenhouse.git', branch: 'feat/x', base: 'main'})
    })

    it("says all of it, with the project's repo, from a folder inside the repo", () => {
        const dir = repo()
        mkdirSync(join(dir, 'web'))
        expect(repoContext(join(dir, 'web'), {project: 'greenhouse', repo: 'https://github.com/hati/greenhouse'})).toBe([
            `orrery: this session is in the git repo at ${dir} (the folder is ${join(dir, 'web')}).`,
            '- origin: git@github.com:Hati/Greenhouse.git',
            '- branch: feat/x',
            '- default branch: main',
            `- project "greenhouse"'s repo in orrery is https://github.com/hati/greenhouse`,
        ].join('\n'))
    })

    it("says when the project's repo isn't this folder's origin, or when it names none", () => {
        const dir = repo()
        expect(repoContext(dir, {project: 'greenhouse', repo: 'https://github.com/hati/pantry'}))
            .toContain(`- project "greenhouse"'s repo in orrery is https://github.com/hati/pantry: not this folder's origin, so check which repo the work belongs in`)
        expect(repoContext(dir, {project: 'greenhouse'})).toContain('- project "greenhouse" names no repo in orrery')
    })

    it('says a detached head, and a default branch it can’t tell', () => {
        const dir = folder()
        git(dir, 'init', '-q', '-b', 'main')
        git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'first')
        git(dir, 'switch', '-q', '--detach')
        const said = repoContext(dir, {project: 'greenhouse'})
        expect(said).toMatch(/- branch: none \(detached at [0-9a-f]+\)/)
        expect(said).toContain('- origin: none')
        expect(said).toContain("- default branch: not known (origin/HEAD isn't set)")
    })

    it("says there's no repo in a folder outside one, so Claude doesn't look", () => {
        const dir = folder()
        expect(repoContext(dir, {project: 'greenhouse'})).toBe(`orrery: this session's folder, ${dir}, isn't in a git repo. There's no repo to work in here; don't look for one.`)
        expect(repoContext(dir, {project: 'greenhouse', repo: 'https://github.com/hati/greenhouse'}))
            .toContain(`Project "greenhouse"'s repo in orrery is https://github.com/hati/greenhouse, and it isn't checked out in this folder.`)
    })

    it('knows a GitHub repo by owner and name in any of its forms', () => {
        for (const address of ['https://github.com/Hati/Greenhouse', 'https://github.com/hati/greenhouse.git', 'git@github.com:hati/greenhouse.git', 'ssh://git@github.com/hati/greenhouse/'])
            expect(githubName(address)).toBe('hati/greenhouse')
        expect(githubName('https://gitlab.com/hati/greenhouse')).toBeUndefined()
        expect(githubName(undefined)).toBeUndefined()
    })
})

/** Runs the hook on `hook` against a stand-in orrery answering `answer`, with `env`; what it printed. */
async function runHook(hook: Record<string, unknown>, answer: Record<string, unknown>, env: Record<string, string> = {}) {
    const server = createServer((req, res) => {
        req.resume()
        req.on('end', () => res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(answer)))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
        const child = spawn(process.execPath, [HOOK], {env: {PATH: process.env.PATH, HOME: folder(), ORRERY_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ORRERY_PROJECT: 'greenhouse', ...env}})
        let out = ''
        child.stdout.on('data', chunk => out += chunk)
        child.stdin.end(JSON.stringify(hook))
        await new Promise(resolve => child.on('close', resolve))
        return out
    } finally {
        server.close()
    }
}

describe("the hook's SessionStart", () => {
    it('tells the session its repo, then the brief', async () => {
        const dir = repo()
        const out = await runHook({hook_event_name: 'SessionStart', session_id: 'abc', cwd: dir, source: 'clear'}, {id: 'abc', brief: 'orrery: carry on.', repo: 'https://github.com/hati/greenhouse'})
        expect(out).toBe(`${repoContext(dir, {project: 'greenhouse', repo: 'https://github.com/hati/greenhouse'})}\n\norrery: carry on.\n`)
    })

    it('leaves the repo out where the launcher has told it, and on every other event', async () => {
        const dir = repo()
        expect(await runHook({hook_event_name: 'SessionStart', session_id: 'abc', cwd: dir}, {id: 'abc', brief: 'b', repo: null}, {ORRERY_REPO_TOLD: 'yes'})).toBe('b\n')
        expect(await runHook({hook_event_name: 'Stop', session_id: 'abc', cwd: dir}, {id: 'abc', repo: null})).toBe('')
    })
})

/** What the hook, run on `hook` with `env` and no ORRERY_PROJECT, posts to a stand-in orrery whose launcher's list is
 * `list` (none when left out). */
async function hookPosts(hook: Record<string, unknown>, list?: (url: string) => object, env: Record<string, string> = {}) {
    const posted: {project?: string}[] = []
    const server = createServer((req, res) => {
        let body = ''
        req.on('data', chunk => body += chunk)
        req.on('end', () => {
            posted.push(JSON.parse(body || '{}'))
            res.writeHead(200, {'Content-Type': 'application/json'}).end('{}')
        })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        const config = folder()
        if (list) {
            mkdirSync(join(config, 'orrery'))
            writeFileSync(join(config, 'orrery', 'launcher.json'), JSON.stringify(list(url)))
        }
        const child = spawn(process.execPath, [HOOK], {env: {PATH: process.env.PATH, HOME: folder(), XDG_CONFIG_HOME: config, ORRERY_URL: url, ...env}})
        child.stdin.end(JSON.stringify(hook))
        await new Promise(resolve => child.on('close', resolve))
        return posted
    } finally {
        server.close()
    }
}

describe("the hook's project (ORR-1068)", () => {
    it("is the one the launcher's list maps the folder to, the folder inside it too", async () => {
        const dir = repo()
        mkdirSync(join(dir, 'web'))
        const list = (url: string) => ({projects: [{url, project: 'pantry', dir}]})
        expect(await hookPosts({hook_event_name: 'Stop', session_id: 'abc', cwd: join(dir, 'web')}, list)).toMatchObject([{project: 'pantry'}])
        expect(await hookPosts({hook_event_name: 'Stop', session_id: 'abc', cwd: dir}, list, {ORRERY_SCOPE: 'user'})).toMatchObject([{project: 'pantry'}])
    })

    it("says nothing in a folder no orrery knows, rather than taking the folder's name for a project", async () => {
        const dir = repo()
        expect(await hookPosts({hook_event_name: 'Stop', session_id: 'abc', cwd: dir})).toEqual([])
        expect(await hookPosts({hook_event_name: 'Stop', session_id: 'abc', cwd: dir}, url => ({projects: [{url: `${url}/other`, project: 'pantry', dir}]}))).toEqual([])
    })
})
