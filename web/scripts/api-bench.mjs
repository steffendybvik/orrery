// How long the Rust API's routes take alone, with no Nuxt server or browser in front (`pnpm api-bench`, after
// `cargo build --release` in api/), ORR-1114. It starts the API on a copy of BENCH_DB (an orrery's SQLite file, e.g. the
// playground's), runs each route at each concurrency for BENCH_SECONDS, reads first and writes after, as the writes grow
// the board, and prints a Markdown table of requests a second and p50/p95/p99/max. Note the machine's load beside it:
// a busy machine slows every route alike, which is how to tell it from a slow route.
// BENCH_DB (required), BENCH_PROJECT (the first project), BENCH_LEVELS (1,8,64), BENCH_SECONDS (6), BENCH_ONLY (part
// of a route's name, comma-separated), API_BIN (api/target/release/orrery-api), BENCH_PORT (9177).
import {spawn} from 'node:child_process'
import {mkdtempSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {loadavg, tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {DatabaseSync} from 'node:sqlite'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const source = process.env.BENCH_DB
if (!source) throw new Error('Set BENCH_DB to an orrery database to copy, e.g. ../orrery-playground/.playground/data/orrery.db')
const bin = process.env.API_BIN ?? join(repo, 'api/target/release/orrery-api')
const seconds = Number(process.env.BENCH_SECONDS ?? 6)
const levels = (process.env.BENCH_LEVELS ?? '1,8,64').split(',').map(Number)
const only = process.env.BENCH_ONLY?.split(',')
const port = Number(process.env.BENCH_PORT ?? 9177)
const base = `http://127.0.0.1:${port}`

// A copy taken with SQLite's own backup, so a live database's WAL comes with it.
const database = join(mkdtempSync(join(tmpdir(), 'orrery-api-bench-')), 'bench.db')
const from = new DatabaseSync(source, {readOnly: true})
from.exec(`VACUUM INTO '${database.replaceAll("'", "''")}'`)
from.close()
const project = process.env.BENCH_PROJECT ?? new DatabaseSync(database, {readOnly: true}).prepare('SELECT id FROM projects ORDER BY created_at LIMIT 1').get().id

const token = createHash('sha256').update(String(Math.random())).digest('hex')
const api = spawn(bin, [], {stdio: ['ignore', 'ignore', 'inherit'], env: {...process.env, NUXT_API_TOKEN: token, NUXT_DATABASE: database, ORRERY_API_LISTEN: `127.0.0.1:${port}`}})
process.on('exit', () => api.kill())
// As the router sends a local browser's request with logins off (api-router.ts: OWN_WORK aside, cameHeaders, loginHeaders).
const HEADERS = {
    'Orrery-API-Token': token,
    'Orrery-Database': createHash('sha256').update(database).digest('hex'),
    'Orrery-Came': 'loopback',
    'Orrery-Login-Ways': 'off',
    'Orrery-Actor': 'claude',
    'Content-Type': 'application/json',
}
for (let tries = 0; ; tries++) {
    if (await fetch(`${base}/health`).then(r => r.ok, () => false)) break
    if (tries > 100) throw new Error(`The API didn't answer on ${base}`)
    await new Promise(resolve => setTimeout(resolve, 100))
}

const P = `/api/projects/${encodeURIComponent(project)}`
const issues = (await (await fetch(base + `${P}/issues`, {headers: HEADERS})).json()).map(i => i.id)
const latest = (await (await fetch(base + '/api/changes?after=0', {headers: HEADERS})).json()).changes.at(-1)?.id ?? 0
const first = async (path, pick) => fetch(base + path, {headers: HEADERS}).then(r => r.ok ? r.json() : []).then(list => pick(list[0]))
const milestone = await first(`${P}/milestones`, m => m?.id)
const release = await first(`${P}/releases`, r => r?.version)
let n = 0
const next = () => issues[n++ % issues.length]
const ROUTES = {
    'GET /api/projects': () => ['GET', '/api/projects'],
    'GET issues': () => ['GET', `${P}/issues`],
    'GET one issue': () => ['GET', `${P}/issues/${next()}`],
    'GET issues?status=todo': () => ['GET', `${P}/issues?status=todo`],
    'GET issues?assignee=claude': () => ['GET', `${P}/issues?assignee=claude`],
    ...milestone && {'GET a milestone': () => ['GET', `${P}/milestones/${encodeURIComponent(milestone)}`]},
    ...release && {'GET a release': () => ['GET', `${P}/releases/${encodeURIComponent(release)}`]},
    'GET docs?q=': () => ['GET', `${P}/docs?q=${['plan', 'release notes', 'nothing-like-it'][n++ % 3]}`],
    'GET docs': () => ['GET', `${P}/docs`],
    'GET settings': () => ['GET', '/api/settings'],
    'GET changes (outbox follower)': () => ['GET', `/api/changes?after=${Math.max(0, latest - 20)}`],
    'POST comment': () => ['POST', `${P}/issues/${next()}/comments`, {body: 'api-bench'}],
    'PATCH issue': () => ['PATCH', `${P}/issues/${next()}`, {priority: ['P1', 'P2', 'P3'][n % 3]}],
    'POST issue': () => ['POST', `${P}/issues`, {title: `api-bench ${n++}`}],
}

async function time(name, make, concurrency) {
    const took = []
    const statuses = {}
    const end = performance.now() + seconds * 1000
    await Promise.all(Array.from({length: concurrency}, async () => {
        while (performance.now() < end) {
            const [method, path, body] = make()
            const start = performance.now()
            try {
                const response = await fetch(base + path, {method, headers: HEADERS, body: body && JSON.stringify(body)})
                await response.arrayBuffer()
                took.push(performance.now() - start)
                statuses[response.status] = (statuses[response.status] ?? 0) + 1
            }
            catch (error) {
                statuses[error.cause?.code ?? 'error'] = (statuses[error.cause?.code ?? 'error'] ?? 0) + 1
            }
        }
    }))
    took.sort((a, b) => a - b)
    const at = p => took.length ? took[Math.min(took.length - 1, Math.floor(took.length * p))].toFixed(1) : '-'
    const said = Object.entries(statuses).map(([status, count]) => `${status}: ${count}`).join(', ')
    return `| ${name} | ${concurrency} | ${Math.round(took.length / seconds)} | ${at(0.5)} | ${at(0.95)} | ${at(0.99)} | ${at(1)} | ${said} | ${loadavg()[0].toFixed(0)} |`
}

console.log(`${issues.length} issues in ${project}, ${seconds}s a run\n`)
console.log('| Route | Concurrency | req/s | p50 ms | p95 ms | p99 ms | max ms | Statuses | Load |')
console.log('|---|---|---|---|---|---|---|---|---|')
// Reads at every level first, then writes, so the reads all see the same board.
for (const reads of [true, false]) for (const concurrency of levels) for (const [name, make] of Object.entries(ROUTES)) {
    if (name.startsWith('GET') !== reads || (only && !only.some(part => name.includes(part)))) continue
    console.log(await time(name, make, concurrency))
}
process.exit(0)
