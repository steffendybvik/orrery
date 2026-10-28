import type {Signal, StartedSession} from '#shared/roadmap'
import {renderPrompt} from '#shared/prompt'
import {freezeNote} from '#shared/roadmap'
import type {EventEntry} from './event-log'

// One project's signals for a session, as its stream sends them: the owner's, for every session, for one orrery picks
// (pool.ts) or for this one; what it missed, and what it should hear as it connects. A session's channel follows its
// projects on one stream (`/api/signals/stream`) or on one stream each (`…/projects/:project/signals/stream`); both
// open a feed per project here. Each open feed counts the session as listening on its project.

/** Who's on the other end of a stream, as its query says. */
export interface Listener {
    session?: string
    pid?: number
    name?: string
    /** False for a channel in a session not started with the channel flag (`channel=no`): Claude Code drops its
     * messages, so it isn't counted as listening. */
    heard: boolean
    /** The launch orrery started the session for, on this project. */
    started?: StartedSession
    launch?: string
    /** The channel ends its session when the owner stops it. */
    stops: boolean
    /** The name its server goes by in the repo's .mcp.json. */
    server?: string
    /** Its channel says it's an untrusted schedule's session (`untrusted=yes`), whether or not orrery knows its launch. */
    untrusted: boolean
    /** Its channel says it's the owner's chat (`chat=yes`), the same way. */
    chat: boolean
}

export type Feed = Awaited<ReturnType<typeof openFeed>>

/** Opens the project's feed for the listener; `from` is the id to catch up after (none: no catch-up), and `origin`
 * the address the session reaches orrery by, for the addresses in a focus. */
export async function openFeed(project: string, who: Listener, from: number | undefined, origin: string) {
    const store = useStore()
    await store.project(project)
    const {heard} = who
    const attended = who.session || who.pid ? attend(project, who.session, who.pid, who.name, heard, who.started, who.stops, who.launch, who.server, who.untrusted, who.chat) : null
    // An untrusted run's session hears only its own message, and a chat only its chat, so neither is someone there to
    // hear the owner's signals.
    const narrow = who.untrusted || !!who.started?.untrusted || who.chat || !!who.started?.chat
    const stopListening = heard && !narrow ? listen(project) : () => {}
    const done = () => {
        stopListening()
        attended?.done()
    }

    const api = `${origin}/api/projects/${encodeURIComponent(project)}`

    /** The signal with what a session needs to act on it: for a chunk, its open issues (or those of its
     * `status`), most urgent first. Columns go by their statuses' names. A focus comes with its `prompt`:
     * the project's (or the orrery's) template filled in, with the standing instructions picked for it. */
    const told = async (signal: Signal) => {
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
            const {chunk, title, wanted, open: matching} = await scopeOf(store, project, signal)
            const open = matching.map(t => ({id: t.id, title: t.title, column: t.column, priority: t.priority ?? null}))
            // Another session's, while it's there: refused to this one (Store.claim), so it's marked to skip.
            const me = who.session ? currentId(who.session) : undefined
            const taken = new Set(me ? (await Promise.all(open.map(async i => await store.takenFrom(project, i.id, me) ? i.id : null))).filter(Boolean) : [])
            const status = wanted.length ? wanted.map(s => statuses.find(st => st.id === s)?.name ?? s).join(' or ') : undefined
            const query = new URLSearchParams({...!signal.chunk || signal.chunk === 'all' ? {} : {chunk: signal.chunk}, ...signal.status ? {status: signal.status} : {}, ...signal.release ? {release: signal.release} : {}})
            const prompt = renderPrompt(templates.chunk, {
                actor: signal.created_by, chunk: signal.chunk, title, status: status ?? 'open', priority: chunk.priority,
                where: where(name(chunk.column), chunk.priority), note: signal.note,
                issues: open.map(i => issueLine(i, statuses) + (taken.has(i.id) ? ' (another session is on it: skip it)' : '')).join('\n') || '- none left',
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
        return {...signal, title: issue.title, column: name(issue.column), priority: issue.priority ?? null, chunk: chunk?.title ?? null, prompt}
    }
    // The owner's signals for every session, for one orrery picks, or for this one (by any id it has had); a receipt (delivered_to) isn't news.
    const ours = (signal: Signal) => aimedAt(signal, attended?.id)
    const wanted = (signal: Signal) => signal.project === project && signal.protected && !signal.delivered_to.length && ours(signal)
    // One aimed at no session goes to the one that takes it (pool.ts); a session that can't hear it takes none.
    const mine = (signal: Signal) => !pooled(signal) || heard && take(signal, project, attended?.id)
    // Live signals are heard from before the catch-up is read, and held until it has gone out, so one sent in
    // between isn't lost; `goLive` takes them once it has (those in the catch-up too are left out).
    const early: Signal[] = []
    let live: ((signal: Signal) => void) | null = null
    const hear = (signal: Signal) => live ? live(signal) : early.push(signal)
    projectEvents.on('signal', hear)
    const goLive = (deliver: (signal: Signal) => void, already: Set<number>) => {
        live = deliver
        early.splice(0).filter(s => !already.has(s.id)).forEach(deliver)
    }
    let missed: Signal[]
    try {
        missed = from !== undefined ? (await store.listSignals(project, from)).filter(s => s.project === project && s.protected && ours(s)) : []
    } catch (error) {
        projectEvents.off('signal', hear)
        done()
        throw error
    }

    // This session going idle takes up what was sent to one session while every one was busy, as the stream sends it
    // (`onIdle`).
    let sendIdle: (signal: Signal) => unknown = () => {}
    const idle = async (id: string) => {
        if (!attended || !heard || currentId(id) !== attended.id) return
        try {
            for (const signal of await store.pooledWaiting(project)) sendIdle(signal)
        } catch (error) {
            console.error(`[orrery] ${project}'s waiting signals:`, error)
        }
    }
    projectEvents.on('session-idle', idle)

    /** Sends signals one after another, in the order they came, however long each takes to read. */
    let queue: Promise<unknown> = Promise.resolve()
    const inOrder = (work: () => Promise<unknown>) => {
        queue = queue.then(work).catch(error => console.error(`[orrery] a signal for ${project}:`, error))
    }

    let open = true
    return {
        project, attended, heard, missed, told, ours, wanted, mine, goLive, inOrder,
        /** Whether the live feed has started (`goLive`). */
        get live() {
            return !!live
        },
        onIdle(send: (signal: Signal) => unknown) {
            sendIdle = send
        },
        /** The stream's gone: what it listened for, and what its session took and didn't hand on (pool.ts). */
        close() {
            if (!open) return
            open = false
            projectEvents.off('signal', hear)
            projectEvents.off('session-idle', idle)
            if (attended) handBack(project, attended.id)
            done()
        },
    }
}

/** Sends the feed's signals on a server-sent event stream as `signal` events, each with its id: what it missed and
 * what it should hear as it connects (scheduled work nobody heard, the owner's unanswered comments), then each as
 * it's sent. Several feeds can share a stream. */
/** Tells the session on a stream its name as a `name` event `{name}`: once it's known, and again whenever it changes
 * (a move to another project, a name its hooks give). Says how to stop. */
export function sayName(stream: {push: (message: {event: string, data: string}) => unknown}, session: () => string | undefined): () => void {
    let said: string | undefined
    const say = () => {
        const name = sessionName(session())
        if (!name || name === said) return
        said = name
        stream.push({event: 'name', data: JSON.stringify({name})})
    }
    say()
    projectEvents.on('sessions', say)
    return () => projectEvents.off('sessions', say)
}

export async function streamFeed(stream: {push: (message: {id?: string, event: string, data: string}) => unknown}, feed: Feed, name?: string) {
    const {project, attended, heard} = feed
    const store = useStore()
    /** The context the owner started this session with, which every signal to it carries, for its channel to add. */
    const context = () => {
        const given = attended && sessionNow(attended.id)?.started?.context
        return given ? {context: contextBlock(given)} : {}
    }
    /** When each repeatable message last went out on this stream, and every signal it sent. */
    const sent = new Map<string, number>()
    const pushed = new Set<number>()
    const push = (signal: Signal) => {
        if (pushed.has(signal.id)) return
        pushed.add(signal.id)
        const key = repeatKey(signal)
        if (key) sent.set(key, Date.now())
        if (attended) startRun(attended.id, signal)
        feed.inOrder(async () => stream.push({id: String(signal.id), event: 'signal', data: JSON.stringify({...await feed.told(signal), ...context()})}))
    }
    // A schedule's message again while the session hasn't finished a turn since the last copy (busy, or yet to
    // read it) would only pile up behind it: it counts as heard. A session whose hooks never said it went idle
    // gets every copy, as there's no telling.
    const unread = (signal: Signal) => {
        const key = repeatKey(signal)
        const last = key && sent.get(key)
        const idle = attended ? idleAt(attended.id) : undefined
        return !!last && idle !== undefined && idle < last
    }
    const send = (signal: Signal) => {
        if (!feed.wanted(signal) || !feed.mine(signal)) return
        if (!unread(signal)) return push(signal)
        store.delivered(project, signal.id, (attended && sessionName(attended.id)) ?? name ?? 'a session')
            .catch(error => console.error(`[orrery] a repeat for ${project}:`, error))
    }
    feed.onIdle(send)
    // A session that can hear catches up on scheduled work nobody was there to hear, and on the owner's
    // comments nobody has answered yet. A failure there leaves the stream open for what comes next.
    try {
        const unheard = attended && heard ? (await store.unheardScheduled(project)).filter(feed.ours) : []
        // A schedule that kept sending the same message while nobody heard it says it once; the copies count as heard.
        const backlog = [...feed.missed, ...unheard.filter(s => !feed.missed.some(m => m.id === s.id))]
        const {kept, repeats} = foldRepeats(backlog)
        kept.filter(feed.mine).forEach(push)
        feed.goLive(send, new Set(backlog.map(s => s.id)))
        if (attended && heard) {
            const who = sessionName(attended.id) ?? name ?? 'a session'
            for (const s of repeats) await store.delivered(project, s.id, who)
            await store.carryUnanswered(project, attended.id)
        }
    } catch (error) {
        console.error(`[orrery] catching ${project}'s stream up:`, error)
        if (!feed.live) feed.goLive(send, new Set(feed.missed.map(s => s.id)))
    }
}

/** Who a stream's query says is listening. The launch a session orrery started says it's for (`started`) goes with
 * its project's feed only (`launchedHere`), and is looked up once. */
export function listenerOf(text: (key: string) => string | undefined, launchedHere = true): Listener {
    const launch = launchedHere ? text('started') : undefined
    return {
        session: text('session'), pid: Number(text('pid')) || undefined, name: text('name'), heard: text('channel') !== 'no',
        started: launch ? launched(launch) : undefined, launch, stops: text('stops') === 'yes', server: text('server'),
        untrusted: text('untrusted') === 'yes',
        chat: text('chat') === 'yes',
    }
}

/** A session's channel connecting to the feed (`connected`) or leaving it (`left`), as the event log keeps it: who,
 * on which projects (`every` for `*`), and whether Claude Code hears it. */
export function channelEntry(what: 'connected' | 'left', projects: string[], every: boolean, who: Listener, session?: string, name?: string): EventEntry {
    const called = name || who.name || session || (who.pid ? `pid ${who.pid}` : 'A session')
    const on = every ? 'every project' : projects.join(', ')
    return {
        level: 'info', kind: `channel.${what}`, ...projects.length === 1 && !every ? {project: projects[0]} : {},
        message: `${called} ${what === 'connected' ? 'connected to' : 'left'} the feed for ${on}${what === 'connected' && !who.heard ? " (not started with the channel flag: it won't hear)" : ''}`,
        details: {
            ...session ? {session} : {}, projects: every ? ['*'] : projects, heard: who.heard,
            ...who.launch ? {launch: who.launch} : {}, ...who.untrusted ? {untrusted: true} : {},
        },
    }
}

/** Logs the channel connecting, and gives what logs it leaving, once. Not the owner's chat: like the sessions orrery starts
 * for it, it's logged as neither, so nothing runs on it. */
export function noteChannel(projects: string[], every: boolean, who: Listener, session: () => string | undefined): () => void {
    if (who.chat || who.started?.chat) return () => {}
    const id = session()
    useEventLog().note(channelEntry('connected', projects, every, who, id, sessionName(id)))
    // However the stream ends (it can say so more than once), it left once.
    let open = true
    return () => {
        if (!open) return
        open = false
        const now = session() ?? id
        useEventLog().note(channelEntry('left', projects, every, who, now, sessionName(now)))
    }
}
