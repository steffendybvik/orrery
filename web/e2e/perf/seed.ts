// A big orrery for the performance run (`pnpm test:e2e:perf`): seed.setup.ts fills the fresh one the built server runs
// on, over HTTP, as people and agents would, since the board's data is the Rust API's alone and only it writes it
// (ORR-1240). The history, the event log and the schedules' runs go straight into the database as rows, a batch at a
// time, and so do the comments' dates: written one change at a time they'd take longer to seed than the run takes to
// measure. Each size is a PERF_* variable, its default well past what a real orrery holds, and the same seed gives the
// same orrery every run (bar the order of the comments' ids, which are sent a few at a time).
/** A value in a row. */
export type Value = string | number | null

/** The database the server runs on, for the bulk rows: SQL with `?` placeholders (seed.setup.ts opens it). */
export interface Rows {
    run(sql: string, ...params: Value[]): Promise<unknown>
    all<T>(sql: string, ...params: Value[]): Promise<T[]>
    transaction(work: () => Promise<void>): Promise<void>
}

export interface Sizes {
    projects: number
    issues: number
    comments: number
    history: number
    proposals: number
    events: number
    docs: number
    schedules: number
}

export const SIZES: Sizes = {projects: 20, issues: 3000, comments: 20_000, history: 50_000, proposals: 40, events: 5000, docs: 200, schedules: 60}

/** The sizes, each from its PERF_* variable (PERF_ISSUES…) when it's set. */
export function sizesFrom(env: Record<string, string | undefined>): Sizes {
    return Object.fromEntries(Object.entries(SIZES).map(([key, n]) => [key, Number(env[`PERF_${key.toUpperCase()}`] || n)])) as unknown as Sizes
}

/** The project with the most issues, and in it the one with the longest history: what the spec opens. */
export const BIG = {project: 'atlas', issue: 'ATL-1'}
/** Who a call is from: the owner, or an agent. */
export type Actor = 'ada_lovelace' | 'claude'
export const OWNER: Actor = 'ada_lovelace'
const AGENT: Actor = 'claude'

/** A call to the orrery, as `actor`, answering its JSON; it throws on a refusal. */
export type Call = <T = {id: string}>(method: 'POST' | 'PUT' | 'PATCH', path: string, body: object, actor?: Actor) => Promise<T>

/** Runs `jobs` a few at a time. */
async function pool(jobs: (() => Promise<unknown>)[], width = 8) {
    let next = 0
    await Promise.all(Array.from({length: width}, async () => {
        while (next < jobs.length) await jobs[next++]!()
    }))
}

const NAMES = ['Atlas', 'Beacon', 'Cobalt', 'Delta', 'Ember', 'Fjord', 'Garnet', 'Harbor', 'Indigo', 'Juniper', 'Kestrel', 'Lumen',
    'Meridian', 'Nimbus', 'Onyx', 'Pylon', 'Quartz', 'Rivet', 'Sable', 'Tundra', 'Umber', 'Vesper', 'Willow', 'Xenon', 'Yarrow', 'Zephyr']
const WORDS = ['parse', 'cache', 'render', 'sync', 'export', 'import', 'retry', 'index', 'stream', 'queue', 'login', 'billing', 'search',
    'upload', 'theme', 'layout', 'audit', 'webhook', 'invoice', 'report', 'filter', 'session', 'backup', 'schema']
const STATUSES = ['backlog', 'todo', 'todo', 'in-progress', 'in-review', 'done', 'done', 'done', 'canceled']
const PRIORITIES = [null, 'P0', 'P1', 'P2', 'P2', 'P3', 'P3']
const LABELS = ['bug', 'docs', 'ux', 'perf', 'security', 'api', 'design']

/** A small seeded generator, so every run gets the same orrery. */
function random(seed: number) {
    let a = seed
    const next = () => {
        a = a + 0x6D2B79F5 | 0
        let t = Math.imul(a ^ a >>> 15, 1 | a)
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
        return ((t ^ t >>> 14) >>> 0) / 4294967296
    }
    const int = (n: number) => Math.floor(next() * n)
    const pick = <T>(list: readonly T[]): T => list[int(list.length)]!
    return {next, int, pick, words: (n: number) => Array.from({length: n}, () => pick(WORDS)).join(' ')}
}

/** `size` split over `parts`, the first taking `share` of it and the rest the remainder evenly. */
function split(size: number, parts: number, share: number): number[] {
    const first = parts === 1 ? size : Math.round(size * share)
    const rest = parts - 1
    return [first, ...Array.from({length: rest}, (_, i) => Math.floor((size - first) / rest) + (i < (size - first) % rest ? 1 : 0))]
}

/** Inserts `rows` into `table` a few hundred at a time, in one transaction. */
async function insert(db: Rows, table: string, columns: string[], rows: Value[][]) {
    const batch = Math.floor(30_000 / columns.length)
    await db.transaction(async () => {
        for (let i = 0; i < rows.length; i += batch) {
            const milestone = rows.slice(i, i + batch)
            await db.run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${milestone.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ')}`, ...milestone.flat())
        }
    })
}

/** A time `minutes` before `now`, as the store writes them. */
const ago = (now: number, minutes: number) => new Date(now - minutes * 60_000).toISOString()

/** Fills a new orrery through `call`, with the bulk rows written into `db`, its database, and says what it put in. */
export async function seed(call: Call, db: Rows, sizes: Sizes = SIZES, log: (line: string) => void = () => {}): Promise<Record<string, number>> {
    const r = random(432)
    const now = Date.now()
    await call('PUT', '/api/owner', {name: 'Ada Lovelace'}, OWNER)
    await call('PATCH', '/api/settings', {advanced: true}, OWNER)
    const projectsPath = (id: string) => `/api/projects/${encodeURIComponent(id)}`

    // Projects, each with milestones, releases and docs; the first is the big one.
    const projects: {id: string, milestones: string[], releases: string[], issues: string[]}[] = []
    const names = Array.from({length: sizes.projects}, (_, i) => NAMES[i % NAMES.length] + (i < NAMES.length ? '' : ` ${Math.floor(i / NAMES.length) + 1}`))
    for (const [i, name] of names.entries()) {
        const made = await call('POST', '/api/projects', {name, description: `The ${name.toLowerCase()} service: ${r.words(12)}.`, release_mode: 'own'}, i % 3 ? AGENT : OWNER)
        const milestones: string[] = []
        for (let c = 0; c < (i === 0 ? 12 : 6); c++) milestones.push((await call('POST', `${projectsPath(made.id)}/milestones`, {title: `${r.words(2)} ${c + 1}`, summary: r.words(20)}, OWNER)).id)
        const releases: string[] = []
        for (let v = 0; v < (i === 0 ? 8 : 3); v++) {
            const version = `${Math.floor(v / 4) + 1}.${v % 4}.0`
            await call('POST', `${projectsPath(made.id)}/releases`, {version, notes: r.words(15), ...v < 2 ? {shipped_on: ago(now, (30 - v * 10) * 24 * 60).slice(0, 10)} : {}}, OWNER)
            releases.push(version)
        }
        projects.push({id: made.id, milestones, releases, issues: []})
    }
    log(`${projects.length} projects`)

    // Issues: roots in a milestone or none, a third with sub-issues, some of those nested again (three deep at most).
    const issueSplit = split(sizes.issues - sizes.proposals, projects.length, 0.4)
    const make = async (project: typeof projects[number], parent: string | null, depth: number): Promise<number> => {
        const status = r.pick(STATUSES)
        const issue = await call('POST', `${projectsPath(project.id)}/issues`, {
            title: `${r.words(4)} (${project.issues.length + 1})`,
            notes: r.next() < 0.6 ? `${r.words(40)}\n\n- ${r.words(8)}\n- ${r.words(8)}\n\n\`\`\`\n${r.words(10)}\n\`\`\`` : undefined,
            status, priority: r.pick(PRIORITIES), labels: r.next() < 0.5 ? [r.pick(LABELS)] : [],
            assignee: status === 'in-progress' || status === 'in-review' ? r.pick(['claude', 'ada_lovelace']) : r.next() < 0.2 ? 'claude' : null,
            ...parent ? {parent} : r.next() < 0.8 ? {milestone: r.pick(project.milestones)} : {},
            ...!parent && r.next() < 0.4 ? {release: r.pick(project.releases)} : {},
        }, r.next() < 0.7 ? AGENT : OWNER)
        project.issues.push(issue.id)
        let made = 1
        if (depth < 3 && r.next() < (depth === 1 ? 0.33 : 0.4)) {
            for (let n = 1 + r.int(3); n > 0; n--) made += await make(project, issue.id, depth + 1)
        }
        return made
    }
    for (const [i, project] of projects.entries()) {
        for (let made = 0; made < issueSplit[i]!;) made += await make(project, null, 1)
        log(`${project.id}: ${project.issues.length} issues`)
    }

    // Agents' proposals waiting on the owner, a few with choices.
    for (let p = 0; p < sizes.proposals; p++) {
        const project = projects[p % projects.length]!
        const issue = await call('POST', `${projectsPath(project.id)}/issues`, {
            title: `Proposal: ${r.words(5)}`, notes: r.words(60), proposal: 'pending',
            ...p % 3 === 0 ? {choices: [{key: 'how', question: `How should we ${r.pick(WORDS)}?`, pick: 'one',
                options: [{key: 'a', title: r.words(3)}, {key: 'b', title: r.words(3)}], recommended: ['a']}]} : {},
        }, AGENT)
        project.issues.push(issue.id)
    }
    log(`${sizes.proposals} proposals`)

    // Comments: a long thread on the big issue, the rest spread out; most from agents, some asking the owner.
    const all = projects.flatMap(p => p.issues.map(issue => ({project: p.id, issue})))
    const long = Math.min(400, Math.floor(sizes.comments / 10))
    const comments: (() => Promise<unknown>)[] = []
    let sent = 0
    for (let c = 0; c < sizes.comments; c++) {
        const on = c < long ? BIG : r.pick(all)
        const agent = r.next() < 0.75
        const asks = agent && r.next() < 0.03 ? r.pick(['decision', 'feedback'] as const) : undefined
        const body = {body: `${r.words(10 + r.int(60))}${r.next() < 0.2 ? `\n\n- ${r.words(6)}\n- ${r.words(6)}` : ''}`, ...asks ? {asks} : {}}
        comments.push(async () => {
            await call('POST', `${projectsPath(on.project)}/issues/${on.issue}/comments`, body, agent ? AGENT : OWNER)
            if (++sent % 5000 === 0) log(`${sent} comments`)
        })
    }
    await pool(comments)
    // Spread over the last 90 days, newest last, and most of the older agents' ones cleared from the bell.
    const ids = (await db.all<{id: number}>('SELECT id FROM comments ORDER BY id')).map(row => row.id)
    await db.transaction(async () => {
        for (const [i, id] of ids.entries()) await db.run('UPDATE comments SET created_at = ?, updated_at = ? WHERE id = ?', ago(now, (ids.length - i) * 6.5), ago(now, (ids.length - i) * 6.5), id)
        const cut = ids[Math.floor(ids.length * 0.7)] ?? 0
        await db.run('UPDATE comments SET cleared = 1 WHERE owned = 0 AND asks IS NULL AND id < ?', cut)
    })
    log(`${sizes.comments} comments`)

    // History: changes to the issues over the last 90 days, the big issue's among them.
    const fields = ['status', 'status', 'status', 'priority', 'assignee', 'labels', 'milestone', 'title', 'notes', 'release']
    const history: Value[][] = []
    for (let e = 0; e < sizes.history; e++) {
        const on = e < 300 ? BIG : r.pick(all)
        const field = r.pick(fields)
        const [before, after] = field === 'status' ? [r.pick(STATUSES), r.pick(STATUSES)] : field === 'priority' ? [r.pick(PRIORITIES), r.pick(PRIORITIES)]
            : field === 'assignee' ? [null, r.pick(['claude', 'ada_lovelace'])] : [null, null]
        const agent = r.next() < 0.7
        history.push([on.project, on.issue, field, before, after, agent ? 'claude' : 'ada_lovelace', agent ? 0 : 1, ago(now, r.int(90 * 24 * 60))])
    }
    await insert(db, 'issue_events', ['project', 'issue', 'field', 'before', 'after', 'created_by', 'owned', 'created_at'], history)
    log(`${sizes.history} history rows`)

    // The event log: activity (Advanced is on), schedules' runs, and errors, a few still open.
    const kinds = [['info', 'issue.status'], ['info', 'comment.added'], ['info', 'schedule.ran'], ['info', 'session.started'], ['warn', 'schedule.skipped'],
        ['error', 'server.error'], ['error', 'page.error']] as const
    const events: Value[][] = []
    for (let e = 0; e < sizes.events; e++) {
        const [level, kind] = r.pick(kinds)
        const project = r.pick(projects)
        const at = ago(now, r.int(7 * 24 * 60))
        events.push([level, kind, project.id, r.pick(project.issues), `${kind}: ${r.words(8)}`, level === 'error' ? JSON.stringify({stack: r.words(40)}) : null,
            1 + r.int(3), at, at, level === 'error' && r.next() < 0.8 ? at : null])
    }
    await insert(db, 'events', ['level', 'kind', 'project', 'subject', 'message', 'details', 'count', 'first_seen', 'last_seen', 'resolved_at'], events)
    log(`${sizes.events} events`)

    // Docs, long ones, and schedules of every kind with a history of runs.
    for (let d = 0; d < sizes.docs; d++) {
        const project = d < sizes.docs / 4 ? projects[0]! : r.pick(projects)
        await call('POST', `${projectsPath(project.id)}/docs`, {title: `${r.words(3)} ${d + 1}`, body: Array.from({length: 8}, () => `## ${r.words(3)}\n\n${r.words(80)}`).join('\n\n')}, OWNER)
    }
    log(`${sizes.docs} docs`)
    const runs: Value[][] = []
    for (let s = 0; s < sizes.schedules; s++) {
        const project = r.pick(projects)
        const kind = s % 3 === 0 ? 'message' : 'issue'
        const made = await call<{id: number}>('POST', `${projectsPath(project.id)}/schedules`, {
            title: `${r.words(3)} ${s + 1}`, notes: r.words(20), kind,
            ...s % 4 === 3 ? {on: 'issue.status', on_filter: {to: 'in-review'}} : {cron: `${r.int(60)} ${r.int(24)} * * ${1 + r.int(5)}`, timezone: 'UTC'},
        }, OWNER)
        for (let n = 0; n < 30; n++) runs.push([made.id, ago(now, n * 24 * 60 + r.int(600)), kind === 'message' ? r.pick(['sent', 'skipped']) : r.pick(['made', 'skipped', 'failed']), null, null])
    }
    await insert(db, 'schedule_runs', ['schedule', 'at', 'outcome', 'issue', 'note'], runs)
    log(`${sizes.schedules} schedules`)

    const counts: Record<string, number> = {}
    for (const table of ['projects', 'milestones', 'releases', 'issues', 'comments', 'issue_events', 'events', 'docs', 'schedules', 'schedule_runs']) {
        counts[table] = Number((await db.all<{n: number}>(`SELECT count(*) AS n FROM ${table}`))[0]!.n)
    }
    return counts
}
