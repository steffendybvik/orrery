// Moving a whole orrery into another (ORR-1110): the import `pnpm orrery:import` runs (scripts/import-orrery.mjs), and
// App settings' Move to another orrery runs on the server (ORR-1249, server/utils/orrery-moves.ts). Plain JavaScript with
// no dependencies and nothing of Node's, so both can load it.

const TINTS = ['slate', 'blue', 'teal', 'green', 'amber', 'rose', 'violet']
/** The workspace's own settings (`GET /settings`), as ORR-1107 split them from the person's and the server's. */
export const WORKSPACE_SETTINGS = ['tint', 'focus_prompt', 'milestone_prompt', 'instructions', 'tracker', 'starts', 'restrict_proposals', 'advanced', 'work_kinds']
/** A schedule across projects' own fields, as `POST /schedules` takes them. */
const ACROSS_FIELDS = ['kind', 'title', 'notes', 'presets', 'cron', 'on', 'on_filter', 'timezone', 'column', 'priority', 'labels', 'ask', 'skip_open', 'only_if_changed', 'move_from', 'model', 'effort']

// Ids, as the server checks them (board_upload.rs).
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/
const KEY = /^[A-Z][A-Z0-9]{0,9}$/
/** How a milestone's, an epic's, a doc's, a checklist's, a preset's or a schedule's full id starts, so no project's key
 * (RESERVED_KEYS in shared/roadmap/board.ts and text.rs). An orrery from before they were reserved can have one. */
export const RESERVED_KEYS = ['MLS', 'EPC', 'DOC', 'CHK', 'PST', 'SCH']

/** The id itself when it's free, else the first of `id-2`, `id-3`… that is, within the 40 characters an id has. */
export function freeId(id, taken) {
    if (!taken.has(id)) return id
    for (let n = 2; ; n++) {
        const tail = `-${n}`
        const candidate = id.slice(0, 40 - tail.length).replace(/-+$/, '') + tail
        if (SLUG.test(candidate) && !taken.has(candidate)) return candidate
    }
}

/** The key itself when it's free, else the first of `KEY2`, `KEY3`… within the 10 characters a key has. */
export function freeKey(key, taken) {
    if (!taken.has(key)) return key
    for (let n = 2; ; n++) {
        const tail = String(n)
        const candidate = key.slice(0, 10 - tail.length) + tail
        if (KEY.test(candidate) && !taken.has(candidate)) return candidate
    }
}

/**
 * Where each source project goes on the target: its own id and key where they're free, renamed where the target (or a
 * project earlier in the list) has them, or its key is reserved. A project that releases from another comes after it, so its `releases_from`
 * finds the board there. `already`: the projects of the workspace being added to; one with a source project's id or name
 * is taken to be it, brought in before, and left alone.
 */
export function planProjects(source, target, already = []) {
    const there = project => already.find(p => p.id === project.id || p.name.toLowerCase() === project.name.toLowerCase())
    const ids = new Set(target.map(p => p.id))
    const keys = new Set([...target.map(p => p.key), ...RESERVED_KEYS])
    const ordered = []
    const placed = new Set()
    const byId = new Map(source.map(p => [p.id, p]))
    const place = (project, seen = new Set()) => {
        if (placed.has(project.id) || seen.has(project.id)) return
        seen.add(project.id)
        const from = project.releases_from && byId.get(project.releases_from)
        if (from) place(from, seen)
        placed.add(project.id)
        ordered.push(project)
    }
    for (const project of source) place(project)
    return ordered.map(project => {
        const before = there(project)
        if (before) return {from: project.id, id: before.id, key: before.key, name: project.name, skipped: true, renamed: false}
        const id = freeId(project.id, ids)
        const key = freeKey(project.key, keys)
        ids.add(id)
        keys.add(key)
        return {from: project.id, id, key, name: project.name, skipped: false, renamed: id !== project.id || key !== project.key, fromKey: project.key}
    })
}

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Text with each renamed project's page links (`/p/<old>/`) pointing at its new id. */
export function rewriteLinks(text, renames) {
    if (typeof text !== 'string' || !renames.size) return text
    let out = text
    for (const [from, to] of renames) out = out.replace(new RegExp(`/p/${escape(from)}(?=[/)\\s"'#?]|$)`, 'g'), `/p/${to}`)
    return out
}

/**
 * A board's file made ready for the target: renamed projects' ids in its links (`issue_links`, `releases_from`, page
 * links in its text), and every status the source has described, so a schedule's or an issue's status finds the
 * workspace's by name. Returns a new file; the one given stays as it is.
 */
export function prepareFile(file, renames, statuses) {
    const out = structuredClone(file)
    const tables = out.tables ?? {}
    const renamed = id => renames.get(id) ?? id
    for (const project of tables.projects ?? []) {
        if (project.releases_from) project.releases_from = renamed(project.releases_from)
    }
    for (const link of tables.issue_links ?? []) {
        if (link.on_project !== out.project) link.on_project = renamed(link.on_project)
    }
    if (renames.size) {
        for (const rows of Object.values(tables)) {
            for (const row of rows) {
                for (const [column, value] of Object.entries(row)) if (typeof value === 'string' && value.includes('/p/')) row[column] = rewriteLinks(value, renames)
            }
        }
    }
    const described = new Map((out.statuses ?? []).map(s => [s.id, s]))
    for (const status of statuses ?? []) if (!described.has(status.id)) described.set(status.id, status)
    out.statuses = [...described.values()]
    return out
}

/**
 * The epic each imported issue goes back into: `[{project, issue, epic}]`, the target's project id and epic number, from
 * the file's own `epic` (an upload clears it, as epics are numbered across the server).
 */
export function epicAssignments(files, plan, epics) {
    const out = []
    for (const {from, id, skipped} of plan) {
        if (skipped) continue
        for (const issue of files.get(from)?.tables?.issues ?? []) {
            const epic = issue.epic == null ? undefined : epics.get(Number(issue.epic))
            if (epic !== undefined) out.push({project: id, issue: issue.id, epic})
        }
    }
    return out
}

/**
 * The links an upload leaves behind: one to a project brought in after its own (or not at all) isn't kept, as its board
 * isn't there yet. `[{project, issue, depends_on}]`, each issue's whole list as `PATCH` takes it, for the projects that
 * are there by the end.
 */
export function laterLinks(files, plan) {
    const order = new Map(plan.filter(p => !p.skipped).map((p, i) => [p.from, i]))
    const target = new Map(plan.map(p => [p.from, p.id]))
    const out = []
    for (const {from, id, skipped} of plan) {
        if (skipped) continue
        const links = files.get(from)?.tables?.issue_links ?? []
        const byIssue = new Map()
        for (const link of links) byIssue.set(link.issue, [...byIssue.get(link.issue) ?? [], link])
        for (const [issue, list] of byIssue) {
            const dropped = list.some(link => link.on_project !== from && !(order.get(link.on_project) < order.get(from)))
            if (!dropped) continue
            const kept = list.filter(link => link.on_project === from || target.has(link.on_project))
            out.push({project: id, issue, depends_on: kept.map(link => link.on_project === from ? link.on_issue : `${target.get(link.on_project)}/${link.on_issue}`)})
        }
    }
    return out
}

/**
 * How the source's statuses line up with the workspace's: each matched by name and kind (`map`), those to make
 * (`make`, with an id free across the server), and the workspace's that the source doesn't have (`drop`, moved into
 * `into`, the source's first of that kind) once every kind keeps one.
 */
export function planStatuses(source, target, takenIds, workspace) {
    const taken = new Set(takenIds)
    const map = new Map()
    const make = []
    const same = (a, b) => a.name.toLowerCase() === b.name.toLowerCase() && a.kind === b.kind
    for (const status of source) {
        const match = target.find(t => same(t, status))
        if (match) {
            map.set(status.id, match.id)
            continue
        }
        // As a new workspace's own are (`acme-todo`), since a status's id is unique across the server.
        const id = freeId(`${workspace}-${status.id}`, taken)
        taken.add(id)
        make.push({...status, id})
        map.set(status.id, id)
    }
    const kept = new Set(map.values())
    const drop = target.filter(t => !kept.has(t.id)).map(t => {
        const into = source.find(s => s.kind === t.kind)
        return {id: t.id, name: t.name, into: into ? map.get(into.id) : undefined}
    })
    return {map, make, drop}
}

/** What a board's file can send after the board (ORR-1257): nothing else on the board points at these rows. */
export const LATER_TABLES = ['comments', 'milestone_comments', 'issue_events', 'doc_revisions']
/** How much of a board's rows one request carries, well inside a proxy's cap (Cloudflare's is 100 MB) and what a small
 * server holds in memory as it checks them. */
export const PART_SIZE = 4 * 1024 * 1024

const IMAGE = /\/api\/uploads\/([0-9a-f]{24})/g

/** The images a board's file shows, by id. */
export function imagesShown(file) {
    return [...new Set([...JSON.stringify(file?.tables ?? {}).matchAll(IMAGE)].map(match => match[1]))]
}

/** The file with each image it shows that's in `ids` (old → new) named by its new id. Returns a new file. */
export function renameImages(file, ids) {
    if (!ids.size) return file
    const tables = {}
    for (const [table, rows] of Object.entries(file.tables ?? {})) {
        tables[table] = (rows ?? []).map(row => {
            const out = {...row}
            for (const [column, value] of Object.entries(row)) {
                if (typeof value === 'string' && value.includes('/api/uploads/')) out[column] = value.replace(IMAGE, (whole, id) => ids.has(id) ? `/api/uploads/${ids.get(id)}` : whole)
            }
            return out
        })
    }
    return {...file, tables}
}

/**
 * A board's file as requests no bigger than about `size` each: `first`, the board without its images or the rows that can
 * come after it (`LATER_TABLES`, but the comments a schedule's request points at), then `parts`, each a file of the
 * project's row and some of those rows, with the releases marking a doc revision in it.
 */
export function boardParts(file, size = PART_SIZE) {
    const tables = file.tables ?? {}
    const asked = new Set((tables.schedule_requests ?? []).map(request => String(request.comment)))
    const first = {...tables}
    const later = []
    for (const table of LATER_TABLES) {
        const rows = tables[table] ?? []
        first[table] = table === 'comments' ? rows.filter(row => asked.has(String(row.id))) : []
        for (const row of rows) if (!(table === 'comments' && asked.has(String(row.id)))) later.push([table, row])
    }
    const marking = new Map()
    for (const release of tables.releases ?? []) if (release.doc_mark != null) marking.set(String(release.doc_mark), [...marking.get(String(release.doc_mark)) ?? [], release])
    const head = {format: file.format, format_version: file.format_version, schema_step: file.schema_step, exported_at: file.exported_at, project: file.project, people: file.people ?? [], statuses: file.statuses ?? [], uploads: []}
    const parts = []
    let part
    let filled = 0
    for (const [table, row] of later) {
        const weight = JSON.stringify(row).length
        if (!part || (filled && filled + weight > size)) {
            part = {...head, tables: {projects: tables.projects ?? []}}
            parts.push(part)
            filled = 0
        }
        add(part, table, row)
        filled += weight
        if (table === 'doc_revisions') for (const release of marking.get(String(row.id)) ?? []) add(part, 'releases', release)
    }
    return {first: {...file, uploads: [], tables: first}, parts}
}

function add(part, table, row) {
    if (!part.tables[table]) part.tables[table] = []
    part.tables[table].push(row)
}

/** Base64 of the bytes, with nothing of Node's. */
function base64Of(buffer) {
    const bytes = new Uint8Array(buffer)
    let text = ''
    for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
    return btoa(text)
}

/**
 * Sends a board's file to `target` in requests a proxy and a small server both take (ORR-1257): each image it shows on
 * its own (`POST /uploads`, which names it anew, so its text is changed to match), then the board without them and
 * without what can come after it, then that, in parts (`?into=1`). An image is the file's own (`uploads`), or `image(id)`
 * reads it in base64; `sent` (old id → new) keeps one shown on several boards to one copy. → the new board.
 */
export async function sendBoard(target, file, {id, key, own = false, to, image, sent = new Map(), size = PART_SIZE, log = () => {}} = {}) {
    const inFile = new Map((Array.isArray(file.uploads) ? file.uploads : []).map(upload => [upload.id, upload]))
    for (const old of imagesShown(file)) {
        if (sent.has(old)) continue
        const kept = inFile.get(old)
        try {
            const data = kept?.data ?? await image?.(old)
            if (!data) continue
            const made = await target.post('/uploads', {data, ...typeof kept?.name === 'string' ? {name: kept.name} : {}}, to)
            sent.set(old, made.id)
        } catch (error) {
            log(`Couldn't send image ${old}: ${error.message}`)
        }
    }
    const {first, parts} = boardParts(renameImages(file, sent), size)
    const query = new URLSearchParams({...id ? {id} : {}, ...key ? {key} : {}, ...own ? {own: '1'} : {}})
    const board = await target.upload(`/projects/upload?${query}`, JSON.stringify(first), to)
    const into = new URLSearchParams({id: board.id, key: board.key, ...own ? {own: '1'} : {}, into: '1'})
    for (const [n, part] of parts.entries()) {
        try {
            await target.upload(`/projects/upload?${into}`, JSON.stringify(part), to)
        } catch (error) {
            throw new Error(`The board came in as ${board.id}, but part ${n + 1} of ${parts.length} of its comments, events and doc history didn't: ${error.message}`, {cause: error})
        }
    }
    return board
}

/** The summary the owner reads at the end. */
export function summary(report) {
    const lines = []
    const {workspace, projects, settings, statuses, presets, epics, across, schedules, secrets, people, notes, dryRun} = report
    lines.push(dryRun ? `Dry run: nothing was written to ${report.to}.` : `Brought ${report.from} into ${report.to} as workspace "${workspace.name}" (${workspace.id}).`)
    lines.push('')
    lines.push(`Projects (${projects.filter(p => !p.skipped).length}):`)
    for (const p of projects) {
        const counts = p.counts ? `  ${p.counts.issues} issues, ${p.counts.comments} comments, ${p.counts.docs} docs, ${p.counts.schedules} schedules` : ''
        if (p.skipped) lines.push(`  ${p.from}: already in the workspace${p.id !== p.from ? ` as ${p.id}` : ''}, left alone`)
        else if (p.renamed) {
            const reserved = RESERVED_KEYS.includes(p.fromKey)
            const taken = [p.id !== p.from && 'id', p.key !== p.fromKey && !reserved && 'key'].filter(Boolean).join(' and ')
            const why = [taken && `the target has its ${taken}`, reserved && `${p.fromKey} is how another kind of id starts`].filter(Boolean).join(', and ')
            lines.push(`  ${p.from} → ${p.id} (key ${p.fromKey} → ${p.key}): renamed, as ${why}${counts}`)
        }
        else lines.push(`  ${p.id} (${p.key})${counts}`)
        if (p.error) lines.push(`    failed: ${p.error}`)
    }
    if (settings) lines.push('', `Settings: ${settings.length ? settings.join(', ') : 'none set on the source'}`)
    if (statuses) {
        lines.push(`Statuses: ${statuses.matched} matched by name, ${statuses.made.length} made${statuses.made.length ? ` (${statuses.made.join(', ')})` : ''}, ${statuses.dropped.length} of the new workspace's own taken off${statuses.dropped.length ? ` (${statuses.dropped.join(', ')})` : ''}`)
    }
    if (presets) lines.push(`Presets: ${presets.made} made, ${presets.shipped} of orrery's own as the source has them${presets.removed ? `, ${presets.removed} removed as on the source` : ''}`)
    if (epics) lines.push(`Epics: ${epics.made} made, ${epics.comments} comments, ${epics.issues} issues put back in theirs`)
    if (across) lines.push(`Schedules across projects: ${across.made} made${across.made ? ', each project\'s copy from the file replaced by the new one\'s' : ''}`)
    if (schedules) {
        lines.push(schedules.enabled
            ? `Schedules: ${schedules.turnedOn} turned on as they were on the source`
            : `Schedules: every one arrives paused. ${schedules.wasOn.length ? `On at the source: ${schedules.wasOn.join(', ')}. Turn them on there, or run again with --enable-schedules on a fresh workspace.` : 'None was on at the source.'}`)
    }
    if (secrets?.length) {
        lines.push('', 'Secrets to set again (their values can\'t be read back), in the new workspace\'s settings or with PUT /api/secrets/:name:')
        for (const s of secrets) lines.push(`  ${s.name}  hosts: ${s.hosts.join(', ') || 'none'}${s.projects.length ? `  projects: ${s.projects.join(', ')}` : ''}`)
    }
    if (people?.length) lines.push('', `People on the source but not the target (by name): ${people.join(', ')}. Their open issues arrive unassigned; invite them into the workspace.`)
    lines.push('', 'Not carried:')
    for (const note of [
        'secrets\' values, logins, keys and invites (each orrery\'s own)',
        'the event log, signals, sessions, launches and chats (live state, not the board)',
        'the person\'s own settings (handle, starred, hidden) and the machine\'s (terminal)',
        'epic comments keep their words, with who wrote them and when in front, written as you',
        ...notes ?? [],
    ]) lines.push(`  - ${note}`)
    return lines.join('\n')
}

/** A small client for one orrery: its address, a key or a person's name, and the workspace it acts in. */
export function client(base, {key, person, fetch: fetching = globalThis.fetch} = {}) {
    const url = base.replace(/\/+$/, '')
    const request = async (method, path, {body, workspace, raw, bytes} = {}) => {
        const headers = {}
        if (key) headers.Authorization = `Bearer ${key}`
        if (person) {
            headers['Orrery-Actor'] = person
            headers['Orrery-Person'] = person
        }
        if (workspace) headers['Orrery-Workspace'] = workspace
        if (body !== undefined) headers['Content-Type'] = 'application/json'
        const reply = await fetching(`${url}/api${path}`, {method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body)})
        if (bytes && reply.ok) return base64Of(await reply.arrayBuffer())
        const text = await reply.text()
        let value
        try {
            value = text ? JSON.parse(text) : null
        } catch {
            value = text
        }
        if (!reply.ok) {
            const error = new Error(`${method} ${path}: ${reply.status} ${value?.message ?? value?.statusMessage ?? text.slice(0, 200)}`)
            error.status = reply.status
            throw error
        }
        return value
    }
    return {
        url,
        get: (path, options) => request('GET', path, options),
        /** What's at `path`, as base64: an image. */
        bytes: (path, options) => request('GET', path, {...options, bytes: true}),
        post: (path, body, options) => request('POST', path, {...options, body}),
        patch: (path, body, options) => request('PATCH', path, {...options, body}),
        del: (path, options) => request('DELETE', path, options),
        upload: (path, text, options) => request('POST', path, {...options, body: text, raw: true}),
    }
}

/** The whole import, as `main` runs it; every request goes through the two clients, so a test hands it fakes. */
export async function importOrrery({source, target, name, color, fromWorkspace = 'default', add = false, dryRun = false, enableSchedules = false, log = () => {}, progress = () => {}}) {
    const from = {workspace: fromWorkspace}
    const report = {from: source.url, to: target.url, dryRun, notes: []}

    // What the source has: read only.
    const sourceProjects = await source.get('/projects', from)
    const sourceSettings = await source.get('/settings', from)
    const sourceStatuses = sourceSettings.statuses ?? await source.get('/statuses', from)

    // The workspace: a new one, unless told to add to the one by that name.
    const workspaces = await target.get('/workspaces')
    if (!Array.isArray(workspaces)) throw new Error(`${target.url} has no workspaces to add to: it needs an orrery with workspaces (1.0.0-rc.19 or later) and its Rust API`)
    const existing = workspaces.find(w => w.name.toLowerCase() === name.toLowerCase())
    if (existing && !add) throw new Error(`The target already has a workspace "${existing.name}" (${existing.id}): run again with --add to add to it, or choose another --name`)
    if (!existing && add) throw new Error(`The target has no workspace "${name}" to add to`)
    const tint = color ?? (TINTS.includes(sourceSettings.tint) || /^#[0-9a-f]{6}$/i.test(sourceSettings.tint ?? '') ? sourceSettings.tint : undefined)
    const workspace = existing ?? (dryRun ? {id: '(new)', name} : await target.post('/workspaces', {name, ...tint ? {color: tint} : {}}))
    report.workspace = workspace
    const to = {workspace: workspace.id}
    log(`${existing ? 'Adding to' : dryRun ? 'Would make' : 'Made'} workspace "${workspace.name}" (${workspace.id})`)

    const targetProjects = await target.get('/projects')
    const already = existing ? await target.get('/projects', to) : []
    const plan = planProjects(sourceProjects, targetProjects, already)
    report.projects = plan
    const renames = new Map(plan.filter(p => !p.skipped && p.id !== p.from).map(p => [p.from, p.id]))

    // Each board's file, read once.
    const files = new Map()
    const moving = plan.filter(p => !p.skipped)
    for (const p of plan) {
        if (p.skipped) continue
        progress({step: 'reading', project: p.from, done: files.size, total: moving.length})
        const file = await source.get(`/projects/${encodeURIComponent(p.from)}/export`, from)
        files.set(p.from, file)
        const t = file.tables ?? {}
        p.counts = {issues: t.issues?.length ?? 0, comments: (t.comments?.length ?? 0) + (t.milestone_comments?.length ?? 0), docs: t.docs?.length ?? 0, schedules: t.schedules?.length ?? 0}
    }

    // People the boards name that the target hasn't, by name.
    const targetPeople = await target.get('/people').catch(() => [])
    const known = new Set(targetPeople.map(p => String(p.name ?? p.id).toLowerCase()))
    const knownIds = new Set(targetPeople.map(p => String(p.id).toLowerCase()))
    const missing = new Set()
    for (const file of files.values()) for (const person of file.people ?? []) if (!known.has(String(person.name).toLowerCase()) && !knownIds.has(String(person.id).toLowerCase())) missing.add(person.name)
    report.people = [...missing]

    const sourceSecrets = await source.get('/secrets', from).catch(() => [])
    report.secrets = sourceSecrets.map(s => ({name: s.name, hosts: s.hosts ?? [], projects: (s.projects ?? []).map(p => renames.get(p) ?? p)}))
    const sourceAcross = await source.get('/schedules/across', from).catch(() => [])
    const wasOn = []
    for (const p of plan) for (const s of files.get(p.from)?.tables?.schedules ?? []) if (s.enabled && !s.across) wasOn.push(`${p.id}: ${s.title}`)
    for (const s of sourceAcross) if (s.enabled) wasOn.push(`across: ${s.title}`)

    if (dryRun) {
        report.schedules = {enabled: false, wasOn}
        return report
    }

    // Settings: the workspace's own.
    const settings = {}
    for (const field of WORKSPACE_SETTINGS) if (sourceSettings[field] !== undefined && sourceSettings[field] !== null) settings[field] = sourceSettings[field]
    if (Object.keys(settings).length) await target.patch('/settings', settings, to)
    report.settings = Object.keys(settings)
    log(`Settings: ${report.settings.join(', ') || 'none'}`)

    // Statuses: the workspace's own, before the boards that use them.
    const targetStatuses = await target.get('/statuses', to)
    const everyStatus = existing ? targetStatuses : [...targetStatuses, ...(await target.get('/settings').catch(() => ({statuses: []}))).statuses ?? []]
    const statusPlan = planStatuses(sourceStatuses, targetStatuses, everyStatus.map(s => s.id), workspace.id)
    for (const status of statusPlan.make) await target.post('/statuses', {id: status.id, name: status.name, kind: status.kind, color: status.color, position: status.position}, to)
    const dropped = []
    if (!existing) {
        for (const status of statusPlan.drop) {
            if (!status.into) continue
            await target.del(`/statuses/${encodeURIComponent(status.id)}?into=${encodeURIComponent(status.into)}`, to)
            dropped.push(status.name)
        }
    }
    for (const status of sourceStatuses) {
        const id = statusPlan.map.get(status.id)
        if (id && !statusPlan.make.some(m => m.id === id)) await target.patch(`/statuses/${encodeURIComponent(id)}`, {color: status.color, position: status.position}, to).catch(() => {})
    }
    report.statuses = {matched: statusPlan.map.size - statusPlan.make.length, made: statusPlan.make.map(s => s.name), dropped}
    log(`Statuses: ${report.statuses.matched} matched, ${statusPlan.make.length} made`)

    // Presets: orrery's own as the source has them, then the source's own.
    const presetMap = new Map()
    const sourcePresets = (await source.get('/presets', from)).filter(p => p.project == null)
    const targetPresets = await target.get('/presets', to)
    const shippedHere = new Map(targetPresets.filter(p => p.default?.key).map(p => [p.default.key, p]))
    const sourceShipped = sourcePresets.filter(p => p.default?.key)
    let restored = []
    if (sourceShipped.some(p => !shippedHere.has(p.default.key))) restored = await target.post('/presets/defaults', {}, to)
    for (const p of restored) if (p.default?.key) shippedHere.set(p.default.key, p)
    let made = 0
    let shipped = 0
    let removed = 0
    for (const preset of sourcePresets) {
        const here = preset.default?.key ? shippedHere.get(preset.default.key) : targetPresets.find(p => !p.default && p.name === preset.name)
        if (here) {
            if (preset.default?.changed || here.text !== preset.text) await target.patch(`/presets/${here.id}`, {name: preset.name, text: preset.text, icon: preset.icon ?? null, color: preset.color ?? null}, to)
            presetMap.set(preset.id, here.id)
            if (preset.default) shipped++
            continue
        }
        const copy = await target.post('/presets', {name: preset.name, text: preset.text, ...preset.icon ? {icon: preset.icon} : {}, ...preset.color ? {color: preset.color} : {}}, to)
        presetMap.set(preset.id, copy.id)
        made++
    }
    if (!existing) {
        const sourceKeys = new Set(sourceShipped.map(p => p.default.key))
        for (const [key, p] of shippedHere) {
            if (sourceKeys.has(key)) continue
            await target.del(`/presets/${p.id}`, to)
            removed++
        }
    }
    report.presets = {made, shipped, removed}
    log(`Presets: ${made} made, ${shipped} of orrery's own`)

    // The boards, one by one, each in requests a proxy and a small server take: its images one at a time, read from the
    // source as they go, then its rows in parts (ORR-1257).
    const images = new Map()
    const image = id => source.bytes(`/uploads/${id}`, from)
    let uploaded = 0
    for (const p of plan) {
        if (p.skipped) continue
        progress({step: 'uploading', project: p.id, done: uploaded++, total: moving.length})
        const file = prepareFile(files.get(p.from), renames, sourceStatuses)
        try {
            await sendBoard(target, file, {id: p.id, key: p.key, own: true, to, image, sent: images, log})
            log(`Uploaded ${p.from}${p.id !== p.from ? ` as ${p.id}` : ''}`)
        } catch (error) {
            p.error = error.message
            log(`Couldn't upload ${p.from}: ${error.message}`)
        }
    }
    progress({step: 'finishing', done: moving.length, total: moving.length})
    const landed = plan.filter(p => !p.skipped && !p.error)
    const landedPlan = plan.filter(p => p.skipped || !p.error)
    // Each board's schedules here, by their id in its file: an upload makes them in the file's order.
    const scheduleIds = new Map()
    for (const p of landed) {
        const here = (await target.get(`/projects/${encodeURIComponent(p.id)}/schedules`)).sort((a, b) => a.id - b.id)
        const fileSchedules = files.get(p.from)?.tables?.schedules ?? []
        scheduleIds.set(p.id, new Map(fileSchedules.map((row, i) => [row.id, here[i]]).filter(([, schedule]) => schedule)))
    }

    // Links to a board brought in later than their own.
    for (const link of laterLinks(files, landedPlan)) {
        if (!landed.some(p => p.id === link.project)) continue
        await target.patch(`/projects/${encodeURIComponent(link.project)}/issues/${encodeURIComponent(link.issue)}`, {depends_on: link.depends_on}).catch(error => report.notes.push(`${link.project}/${link.issue}'s links: ${error.message}`))
    }

    // Schedules: the workspace's presets they named, which the upload leaves out as it only knows the board's own.
    for (const p of landed) {
        for (const schedule of files.get(p.from)?.tables?.schedules ?? []) {
            const here = scheduleIds.get(p.id).get(schedule.id)
            const named = parseList(schedule.presets).map(id => presetMap.get(Number(id))).filter(id => id !== undefined)
            if (!named.length || !here || schedule.across) continue
            await target.patch(`/projects/${encodeURIComponent(p.id)}/schedules/${here.id}`, {presets: [...new Set([...here.presets ?? [], ...named])]})
        }
    }

    // Schedules across projects: made again across the new projects, in place of the plain copies each board's file had.
    const newIds = new Map(landedPlan.map(p => [p.from, p.id]))
    let acrossMade = 0
    const acrossHere = existing ? await target.get('/schedules/across', to) : []
    for (const schedule of sourceAcross) {
        if (acrossHere.some(s => s.title === schedule.title)) continue
        for (const p of landed) {
            for (const row of files.get(p.from)?.tables?.schedules ?? []) {
                const here = scheduleIds.get(p.id).get(row.id)
                if (here && Number(row.across) === Number(schedule.id)) await target.del(`/projects/${encodeURIComponent(p.id)}/schedules/${here.id}`)
            }
        }
        const fields = {}
        for (const field of ACROSS_FIELDS) if (schedule[field] !== undefined && schedule[field] !== null) fields[field] = schedule[field]
        if (fields.presets) fields.presets = fields.presets.map(id => presetMap.get(Number(id))).filter(id => id !== undefined)
        const projects = schedule.projects === '*' ? '*' : (schedule.projects ?? []).map(id => newIds.get(id)).filter(Boolean)
        const skip = (schedule.skip ?? []).map(id => newIds.get(id)).filter(Boolean)
        if (projects !== '*' && !projects.length) continue
        try {
            const acrossCopy = await target.post('/schedules', {...fields, projects, skip, enabled: false}, to)
            acrossMade++
            if (enableSchedules && schedule.enabled) await target.patch(`/schedules/across/${acrossCopy.id}`, {enabled: true}, to)
        } catch (error) {
            report.notes.push(`schedule across projects "${schedule.title}": ${error.message}`)
        }
    }
    report.across = {made: acrossMade}

    let turnedOn = 0
    if (enableSchedules) {
        for (const p of landed) {
            for (const row of files.get(p.from)?.tables?.schedules ?? []) {
                const here = scheduleIds.get(p.id).get(row.id)
                if (!row.enabled || row.across || !here) continue
                await target.patch(`/projects/${encodeURIComponent(p.id)}/schedules/${here.id}`, {enabled: true})
                turnedOn++
            }
        }
        turnedOn += sourceAcross.filter(s => s.enabled).length
    }
    report.schedules = {enabled: enableSchedules, wasOn, turnedOn}

    // Epics, with their comments, and their issues put back in them.
    const epicMap = new Map()
    const sourceEpics = await source.get('/epics', from).catch(() => [])
    const targetEpics = existing ? await target.get('/epics', to) : []
    let epicComments = 0
    let epicsMade = 0
    for (const [position, epic] of sourceEpics.entries()) {
        const here = targetEpics.find(e => e.title === epic.title)
        if (here) {
            epicMap.set(Number(epic.id), here.id)
            continue
        }
        const copy = await target.post('/epics', {title: epic.title, ...epic.notes ? {notes: epic.notes} : {}, position}, to)
        epicMap.set(Number(epic.id), copy.id)
        epicsMade++
        for (const comment of await source.get(`/epics/${epic.id}/comments`, from).catch(() => [])) {
            await target.post(`/epics/${copy.id}/comments`, {body: `*${comment.created_by}, ${comment.created_at?.slice(0, 10) ?? ''}:*\n\n${rewriteLinks(comment.body, renames)}`}, to)
            epicComments++
        }
    }
    const assignments = epicAssignments(files, landedPlan, epicMap)
    for (const {project, issue, epic} of assignments) {
        if (!landed.some(p => p.id === project)) continue
        await target.patch(`/projects/${encodeURIComponent(project)}/issues/${encodeURIComponent(issue)}`, {epic}).catch(error => report.notes.push(`${project}/${issue}'s epic: ${error.message}`))
    }
    report.epics = {made: epicsMade, comments: epicComments, issues: assignments.length}

    return report
}

/** A list column as the file holds it: JSON text, or already a list. */
function parseList(value) {
    if (Array.isArray(value)) return value
    try {
        const parsed = JSON.parse(value ?? '[]')
        return Array.isArray(parsed) ? parsed : []
    } catch {
        return []
    }
}
