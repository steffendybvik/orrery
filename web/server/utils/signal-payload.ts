// What a signal says as its stream sends it (signal-feed.ts): the signal with what a session needs to act on it. A
// chunk focus lists its open issues (or those of its `status`), most urgent first, marking those another session is on;
// a focus comes with its `prompt`, the project's (or the orrery's) template filled in with the standing instructions
// picked for it and, for a release in feature freeze, its note, and then what the issue builds on (ORR-601); a
// schedule's message names its schedule. Columns go by their statuses' names.
import type {Signal} from '#shared/roadmap'
import {renderPrompt} from '#shared/prompt'
import {freezeNote, parseLinkRef} from '#shared/roadmap'
import {columnName, issueLine} from './roadmap'
import {scopeOf} from './scope'
import type {Store} from './store'

/** The signal as session `me` on `project` is told it; `api` is the project's address as the session reaches it. */
export async function signalPayload(store: Store, project: string, signal: Signal, {api, me}: {api: string, me?: string}) {
    const statuses = await store.statuses()
    // A release in feature freeze says so, after the standing instructions.
    const withFreeze = async (version: string | undefined) => {
        const note = version ? freezeNote((await store.project(project)).releases.find(r => r.version === version)) : null
        return note ? [...signal.instructions, note] : signal.instructions
    }
    const templates = await store.prompts(project)
    const where = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(', ')
    const name = (column: string) => columnName(column, statuses)
    if (signal.kind === 'message') {
        // One the owner's chat sent for them says so, to whatever channel hears it.
        const note = signal.via === 'chat' ? `${signal.note}\n\n(Sent by the owner through their chat.)` : signal.note
        if (signal.schedule === undefined) return {...signal, note, title: null, column: null, priority: null, chunk: null}
        let title = 'a schedule'
        try {
            title = (await useScheduler().get(project, signal.schedule)).title
        } catch {
            // The schedule is gone since; its message still stands.
        }
        return {...signal, title, column: null, priority: null, chunk: null}
    }
    if (!signal.issue) {
        const {chunk, title, wanted, open: matching, held} = await scopeOf(store, project, signal)
        const open = matching.map(t => ({id: t.id, title: t.title, column: t.column, priority: t.priority ?? null}))
        // Another session's, while it's there: refused to this one (Store.claim), so it's marked to skip.
        const taken = new Set(me ? (await Promise.all(open.map(async i => await store.takenFrom(project, i.id, me) ? i.id : null))).filter(Boolean) : [])
        const status = wanted.length ? wanted.map(s => statuses.find(st => st.id === s)?.name ?? s).join(' or ') : undefined
        const query = new URLSearchParams({...!signal.chunk || signal.chunk === 'all' ? {} : {chunk: signal.chunk}, ...signal.status ? {status: signal.status} : {}, ...signal.release ? {release: signal.release} : {}})
        const prompt = renderPrompt(templates.chunk, {
            actor: signal.created_by, chunk: signal.chunk, title, status: status ?? 'open', priority: chunk.priority,
            where: where(name(chunk.column), chunk.priority), note: signal.note,
            issues: [
                ...open.map(i => issueLine(i, statuses) + (taken.has(i.id) ? ' (another session is on it: skip it)' : '')),
                // Blocked ones are named, so the session knows they're coming, but not to start (ORR-601).
                ...held.map(i => issueLine({id: i.id, title: i.title, column: i.column, priority: i.priority ?? null}, statuses) + ` (blocked by ${i.blocked_by?.join(', ')}: not until ${i.blocked_by?.length === 1 ? "it's" : "they're"} done)`),
            ].join('\n') || '- none left',
            url: !signal.chunk || signal.chunk === 'none' || signal.chunk === 'all' || signal.release || signal.status?.includes(',')
                ? `'${api}/issues?${query}'` : `${api}/chunks/${encodeURIComponent(signal.chunk)}`,
        }, await withFreeze(signal.release)).replace(' []', '')
        return {...signal, status, title, column: name(chunk.column), priority: chunk.priority ?? null, chunk: title, issues: open.map(i => ({...i, column: name(i.column)})), prompt}
    }
    const issue = await store.issue(project, signal.issue)
    const chunk = (await store.project(project)).board.chunks.find(c => c.id === (issue.chunk ?? ''))
    if (signal.kind !== 'focus') return {...signal, title: issue.title, column: name(issue.column), priority: issue.priority ?? null, chunk: chunk?.title ?? null}
    // A sub-issue set for no release goes out with its parent's.
    let version = issue.release
    for (let parent = issue.parent; !version && parent;) ({release: version, parent} = await store.issue(project, parent))
    const prompt = renderPrompt(templates.focus, {
        actor: signal.created_by, issue: issue.id, title: issue.title, status: name(issue.column), priority: issue.priority, chunk: chunk?.title,
        where: where(name(issue.column), issue.priority, chunk?.title), note: signal.note, url: `${api}/issues/${encodeURIComponent(issue.id)}`,
    }, await withFreeze(version))
    const builds = await buildsOn(store, project, issue.depends_on ?? [], name)
    return {...signal, title: issue.title, column: name(issue.column), priority: issue.priority ?? null, chunk: chunk?.title ?? null, prompt: builds ? `${prompt}\n\n${builds}` : prompt}
}

/** How long a blocker's last comment is told, at most. */
const SAID = 600

/** What an issue builds on (ORR-601), for the session starting it: each issue it depends on, where it stands and its
 * last comment (its outcome, mostly), so the work starts from theirs. None when it depends on none. */
async function buildsOn(store: Store, project: string, refs: string[], name: (column: string) => string): Promise<string | undefined> {
    const lines: string[] = []
    for (const ref of refs) {
        const on = parseLinkRef(project, ref)
        try {
            const blocker = await store.issue(on.project, on.id)
            const last = (await store.listComments(on.project, on.id)).at(-1)
            const said = last?.body.replace(/\s+/g, ' ').trim()
            lines.push(`- ${ref}: ${blocker.title} [${name(blocker.column)}${blocker.kind === 'canceled' ? ': canceled: the owner was asked whether to go ahead' : ''}]`
                + (last && said ? `\n  last comment, by ${last.created_by}: ${said.length > SAID ? `${said.slice(0, SAID)}…` : said}` : ''))
        } catch {
            // Gone since: nothing to build on.
        }
    }
    return lines.length ? `It builds on these; read them (the issue tool) and start from their outcome:\n${lines.join('\n')}` : undefined
}
