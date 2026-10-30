#!/usr/bin/env node
// Runs orrery's channel, hook or launcher as the orrery itself serves them (ORR-435), so upgrading orrery upgrades every
// repo the next time its session or launcher starts, with no checkout on the machine. One per machine, at
// ~/.orrery/bootstrap.mjs, and the same across versions, as nothing updates it:
//   node ~/.orrery/bootstrap.mjs channel|hook|launcher [the script's own flags]
// It fetches only from this machine or over https, as whoever answers there runs code here, and never follows a
// redirect. It checks the orrery against ORRERY_ID, and a file against the sha256 the orrery lists for it, so a copy cut
// short never runs. Each copy stays in ~/.orrery/<orrery id>/, so one it can't fetch runs the last good one; with none it
// says why, but for a hook, which never fails a session. A hook looks for a new copy at most once a minute, and briefly,
// as it runs on every tool. A launcher serves every orrery on its list, so it takes the newest one's. No dependencies.
import {createHash} from 'node:crypto'
import {chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

const SCRIPTS = {channel: 'orrery-channel.mjs', hook: 'orrery-hook.mjs', launcher: 'orrery-launcher.mjs'}
const HOOK_CHECKS_EVERY = 60_000

const sha256 = data => createHash('sha256').update(data).digest('hex')
const trim = url => url.replace(/\/+$/, '')

/** Whether code may be fetched from `url`: this machine's own address, or https. */
export function servable(url) {
    try {
        const {protocol, hostname} = new URL(url)
        return protocol === 'https:' || (protocol === 'http:' && /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/.test(hostname))
    } catch {
        return false
    }
}

const parts = version => {
    const [release, candidate] = String(version).split('-')
    return {numbers: release.split('.').map(Number), candidate: candidate === undefined ? Infinity : Number(candidate.replace(/\D/g, '') || 0)}
}

/** Whether version `a` is newer than `b` (`1.0.0-rc.14` before `1.0.0`). */
export function newer(a, b) {
    const [x, y] = [parts(a), parts(b)]
    for (let i = 0; i < 3; i++) {
        if ((x.numbers[i] ?? 0) !== (y.numbers[i] ?? 0)) return (x.numbers[i] ?? 0) > (y.numbers[i] ?? 0)
    }
    return x.candidate > y.candidate
}

function readJson(file) {
    try {
        return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
        return null
    }
}

/** Writes in one go, so another hook running at the same moment reads the old file or the new one, never half of it. */
function writeWhole(file, data) {
    const part = `${file}.${process.pid}.part`
    writeFileSync(part, data, {mode: 0o600})
    renameSync(part, file)
}

/** The orreries a role's script comes from: a channel's or hook's own, or every one on the launcher's list. */
export function orreriesFor(role, env = process.env, home = homedir()) {
    const own = env.ORRERY_URL ? [trim(env.ORRERY_URL)] : []
    if (role !== 'launcher') return own.length ? own : ['http://localhost:9000']
    const list = readJson(join(env.XDG_CONFIG_HOME || join(home, '.config'), 'orrery', 'launcher.json'))
    const listed = Array.isArray(list?.projects) ? list.projects.map(entry => entry?.url).filter(url => typeof url === 'string').map(trim) : []
    const all = [...new Set([...own, ...listed])]
    return all.length ? all : ['http://localhost:9000']
}

/** What each orrery serves now, the newest first; and why any wouldn't do. */
async function lookUp(urls, {env, fetch, timeout}) {
    const found = []
    const problems = []
    for (const url of urls) {
        if (!servable(url)) {
            problems.push(`${url} isn't on this machine or https, so its code isn't fetched`)
            continue
        }
        try {
            const response = await fetch(`${url}/channel/manifest.json`, {redirect: 'error', signal: AbortSignal.timeout(timeout)})
            if (!response.ok) throw new Error(`it answered ${response.status}`)
            const manifest = await response.json()
            if (env.ORRERY_ID && manifest.id !== env.ORRERY_ID) problems.push(`the orrery at ${url} is ${manifest.id}, not ${env.ORRERY_ID}`)
            else found.push({url, manifest})
        } catch (error) {
            problems.push(`couldn't read ${url}/channel/manifest.json: ${error.message}`)
        }
    }
    return {found: found.sort((a, b) => newer(b.manifest.version, a.manifest.version) ? 1 : newer(a.manifest.version, b.manifest.version) ? -1 : 0), problems}
}

/** Keeps the copies a role's pointer names, and removes the rest. Running processes have theirs loaded already. */
function prune(dir) {
    const kept = new Set(Object.keys(SCRIPTS).map(role => readJson(join(dir, `current-${role}.json`))?.folder))
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
        if (entry.isDirectory() && !kept.has(entry.name)) rmSync(join(dir, entry.name), {recursive: true, force: true})
    }
}

/** The copy of `role`'s script to run: `{path, code, version, from}`, with `problem` saying why it's an old one; or only
 * `problem` with none to run. */
export async function resolve(role, {env = process.env, home = homedir(), fetch = globalThis.fetch, now = Date.now()} = {}) {
    const script = SCRIPTS[role]
    const urls = orreriesFor(role, env, home)
    const dir = join(env.ORRERY_HOME ?? join(home, '.orrery'), role === 'launcher' ? 'launcher' : env.ORRERY_ID ?? `url-${sha256(urls[0]).slice(0, 12)}`)
    mkdirSync(dir, {recursive: true, mode: 0o700})
    const pointer = join(dir, `current-${role}.json`)
    const saved = readJson(pointer)
    const last = saved && existsSync(join(dir, saved.folder, script)) ? {...saved, path: join(dir, saved.folder, script)} : null
    if (role === 'hook' && last && now - (last.checked ?? 0) < HOOK_CHECKS_EVERY) return last
    const keep = () => last && writeWhole(pointer, JSON.stringify({...saved, checked: now}))

    const quick = role === 'hook'
    const {found, problems} = await lookUp(urls, {env, fetch, timeout: quick ? 800 : 5000})
    const best = found[0]
    if (!best) {
        keep()
        return {...last, problem: problems.join('; ')}
    }
    const {url: from, manifest: {version, code, files}} = best
    if (last?.code === code) {
        writeWhole(pointer, JSON.stringify({...saved, from, checked: now}))
        return {...last, from}
    }
    try {
        const response = await fetch(`${from}/channel/${script}`, {redirect: 'error', signal: AbortSignal.timeout(quick ? 2000 : 30_000)})
        if (!response.ok) throw new Error(`it answered ${response.status}`)
        const data = Buffer.from(await response.arrayBuffer())
        if (sha256(data) !== files?.[script]) throw new Error("it isn't the file the orrery lists")
        const folder = `${String(version).replace(/[^\w.-]/g, '_')}-${String(code).replace(/\W/g, '').slice(0, 16)}`
        mkdirSync(join(dir, folder), {recursive: true, mode: 0o700})
        writeWhole(join(dir, folder, script), data)
        chmodSync(join(dir, folder, script), 0o600)
        writeWhole(pointer, JSON.stringify({folder, version, code, from, checked: now}))
        prune(dir)
        return {path: join(dir, folder, script), folder, version, code, from}
    } catch (error) {
        keep()
        return {...last, problem: `couldn't fetch ${script} from ${from}: ${error.message}`}
    }
}

async function main() {
    const role = process.argv[2]
    if (!SCRIPTS[role]) {
        console.error('[orrery bootstrap] run it as: node bootstrap.mjs channel|hook|launcher [flags]')
        process.exit(1)
    }
    process.argv.splice(2, 1)
    const copy = await resolve(role).catch(error => ({problem: error.message}))
    if (!copy.path) {
        if (role === 'hook') process.exit(0)
        console.error(`[orrery bootstrap] nothing to run for the ${role}: ${copy.problem}`)
        process.exit(1)
    }
    if (copy.problem && role !== 'hook') console.error(`[orrery bootstrap] running the last good copy (${copy.version}): ${copy.problem}`)
    process.env.ORRERY_BOOTSTRAP = fileURLToPath(import.meta.url)
    process.env.ORRERY_CODE = copy.code
    process.env.ORRERY_FROM = copy.from ?? ''
    await import(pathToFileURL(copy.path).href)
}

// Only when run: the launcher and tests import what's above.
const run = process.argv[1] ? realpathSync(process.argv[1]) : ''
if (run && run === realpathSync(fileURLToPath(import.meta.url))) await main()
