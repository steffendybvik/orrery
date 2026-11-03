// How a built orrery holds up over time (`pnpm soak`, after `pnpm build`), which the perf suite doesn't look at. On a fresh
// database of its own, it keeps sessions listening, reconnects their streams and the page's live feed, reports hooks, writes
// issues and comments and takes backups, all faster than real use. Every 15 seconds it notes the server's memory, open
// files and how long the project list takes, into web/soak-report/. It fails on a request that errors, and when open
// files keep growing. A short run catches a fast leak: it says nothing of what only shows after days (ORR-736).
// SOAK_MINUTES (30), SOAK_SESSIONS (8) and SOAK_PORT (3360) change it.
import {spawn, execFileSync} from 'node:child_process'
import {existsSync, mkdirSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'

const web = fileURLToPath(new URL('..', import.meta.url))
const minutes = Number(process.env.SOAK_MINUTES ?? 30)
const sessionCount = Number(process.env.SOAK_SESSIONS ?? 8)
const port = Number(process.env.SOAK_PORT ?? 3360)
const base = `http://127.0.0.1:${port}`
const database = `${web}.data/soak.db`
const backups = `${web}.data/soak-backups`
const report = `${web}soak-report`
const HEADERS = {'Content-Type': 'application/json', 'Orrery-Actor': 'claude'}
const PROJECT = 'soak'
const VERSION = '1.0.0'

rmSync(backups, {recursive: true, force: true})
for (const suffix of ['', '-wal', '-shm', '.backups.json']) rmSync(database + suffix, {force: true})
mkdirSync(backups, {recursive: true})
mkdirSync(report, {recursive: true})

const server = spawn('node', ['.output/server/index.mjs'], {
    cwd: web,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: {...process.env, NUXT_DATABASE: database, NUXT_BACKUP_DIR: backups, NUXT_UPDATE_CHECK: 'false', PORT: String(port), NITRO_HOST: '127.0.0.1'},
})
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const counts = {requests: 0, reconnects: 0, backups: 0}
const failures = new Map()

async function call(method, path, body) {
    counts.requests++
    try {
        const response = await fetch(base + path, {method, headers: HEADERS, body: body === undefined ? undefined : JSON.stringify(body)})
        if (!response.ok) {
            const key = `${method} ${path.replace(/[A-Z]+-\d+/, ':issue')} ${response.status}`
            failures.set(key, (failures.get(key) ?? 0) + 1)
        }
        return response.ok && response.status !== 204 ? await response.json() : undefined
    }
    catch (error) {
        const key = `${method} ${path.replace(/[A-Z]+-\d+/, ':issue')} ${error.cause?.code ?? error.message}`
        failures.set(key, (failures.get(key) ?? 0) + 1)
    }
}

/** A stream held the way a channel holds it, its bytes read and dropped. */
function hold(path) {
    const controller = new AbortController()
    fetch(base + path, {signal: controller.signal})
        .then(async response => {
            const reader = response.body.getReader()
            while (!(await reader.read()).done) { /* keep reading */ }
        })
        .catch(() => {})
    return () => controller.abort()
}

function openFiles() {
    try { return execFileSync('lsof', ['-p', String(server.pid)], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).split('\n').length - 2 }
    catch { return NaN }
}
const sizeMb = path => existsSync(path) ? statSync(path).size / 1e6 : 0
const rssMb = () => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(server.pid)], {encoding: 'utf8'})) / 1024

/** The change per hour of `pick` over the samples, by least squares. */
function perHour(samples, pick) {
    const n = samples.length
    const xs = samples.map(s => s.minute / 60)
    const ys = samples.map(pick)
    const mx = xs.reduce((a, b) => a + b, 0) / n
    const my = ys.reduce((a, b) => a + b, 0) / n
    const under = xs.reduce((sum, x) => sum + (x - mx) ** 2, 0)
    return under ? xs.reduce((sum, x, i) => sum + (x - mx) * (ys[i] - my), 0) / under : 0
}

async function main() {
    for (let tried = 0; ; tried++) {
        try { if ((await fetch(`${base}/api/settings`)).ok) break }
        catch { /* not up yet */ }
        if (tried > 120) throw new Error('the server didn\'t start: run `pnpm build` first')
        await sleep(500)
    }
    await call('PUT', '/api/owner', {name: 'Soak Owner'})
    await call('POST', '/api/projects', {name: 'Soak', id: PROJECT, key: 'SOK'})
    const issues = []
    for (let i = 0; i < 20; i++) issues.push((await call('POST', `/api/projects/${PROJECT}/issues`, {title: `Soak ${i}`}))?.id)

    const ids = Array.from({length: sessionCount}, (_, i) => `soak-${i}`)
    const openSession = id => hold(`/api/projects/${PROJECT}/signals/stream?session=${id}&name=${id}&version=${VERSION}&format=text`)
    const sessions = new Map(ids.map(id => [id, openSession(id)]))
    const feeds = [0, 1, 2].map(() => hold('/api/events'))

    const started = Date.now()
    const samples = []
    const end = started + minutes * 60_000
    let tick = 0
    let nextSample = started
    let nextBackup = started + 5 * 60_000
    while (Date.now() < end) {
        tick++
        const issue = issues[tick % issues.length]
        await call('POST', `/api/projects/${PROJECT}/issues/${issue}/comments`, {body: `Soak comment ${tick}`})
        if (tick % 3 === 0) await call('PATCH', `/api/projects/${PROJECT}/issues/${issue}`, {priority: ['P1', 'P2', 'P3'][tick % 9 / 3 | 0]})
        if (tick % 5 === 0) await Promise.all(ids.map(id => call('POST', '/api/sessions', {id, project: PROJECT, name: id, cwd: '/code/soak', event: tick % 10 ? 'UserPromptSubmit' : 'Stop'})))
        // A session's stream dropping and coming back, then a page reloading.
        if (tick % 10 === 0) {
            const id = ids[(tick / 10) % ids.length]
            sessions.get(id)()
            sessions.set(id, openSession(id))
            const feed = (tick / 10) % feeds.length
            feeds[feed]()
            feeds[feed] = hold('/api/events')
            counts.reconnects += 2
        }
        if (Date.now() >= nextBackup) {
            await call('POST', '/api/backups')
            counts.backups++
            nextBackup += 5 * 60_000
        }
        if (Date.now() >= nextSample) {
            const before = performance.now()
            await call('GET', '/api/projects?expand=board')
            const listening = (await call('GET', '/api/sessions'))?.filter(s => s.listening).length ?? 0
            samples.push({
                minute: (Date.now() - started) / 60_000,
                rss_mb: rssMb(),
                open_files: openFiles(),
                list_ms: performance.now() - before,
                db_mb: sizeMb(database) + sizeMb(`${database}-wal`),
                listening,
                requests: counts.requests,
            })
            nextSample += 15_000
        }
        await sleep(250)
    }
    for (const stop of [...sessions.values(), ...feeds]) stop()
    await sleep(3000)
    const openAfter = openFiles()

    // The first fifth is the server warming up.
    const settled = samples.slice(Math.floor(samples.length / 5))
    const first = settled[0]
    const last = settled.at(-1)
    const fileGrowth = last.open_files - first.open_files
    const summary = {
        minutes,
        sessions: sessionCount,
        ...counts,
        failures: Object.fromEntries(failures),
        rss_mb: {settled: Math.round(first.rss_mb), last: Math.round(last.rss_mb), per_hour: Math.round(perHour(settled, s => s.rss_mb))},
        open_files: {settled: first.open_files, last: last.open_files, per_hour: Math.round(perHour(settled, s => s.open_files)), after_streams_closed: openAfter},
        list_ms: {settled: Math.round(first.list_ms), last: Math.round(last.list_ms)},
        db_mb: {last: Math.round(last.db_mb)},
        listening: {least: Math.min(...settled.map(s => s.listening)), expected: sessionCount},
    }
    const columns = Object.keys(samples[0])
    writeFileSync(`${report}/samples.csv`, [columns.join(','), ...samples.map(s => columns.map(c => typeof s[c] === 'number' ? +s[c].toFixed(2) : s[c]).join(','))].join('\n') + '\n')
    writeFileSync(`${report}/summary.json`, JSON.stringify(summary, null, 2) + '\n')
    console.log(JSON.stringify(summary, null, 2))
    return failures.size === 0 && fileGrowth < 30
}

main().then(ok => process.exitCode = ok ? 0 : 1, error => {
    console.error(error)
    process.exitCode = 1
}).finally(() => server.kill())
