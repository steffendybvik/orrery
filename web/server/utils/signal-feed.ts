import type {Signal, StartedSession} from '#shared/roadmap'
import type {EventEntry} from './event-log'
import {signalPayload} from './signal-payload'

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
    /** The version of the code its channel runs (`version=`). */
    version?: string
    /** Its channel says it's the owner's chat (`chat=yes`), the same way. */
    chat: boolean
    /** Whose it is, by what its request says (`personOf`), so it hears only its own person's signals. */
    person?: string
}

export type Feed = Awaited<ReturnType<typeof openFeed>>

/** Opens the project's feed for the listener; `from` is the id to catch up after (none: no catch-up), and `origin`
 * the address the session reaches orrery by, for the addresses in a focus. */
export async function openFeed(project: string, who: Listener, from: number | undefined, origin: string) {
    const store = useStore()
    await store.project(project)
    const {heard} = who
    const attended = who.session || who.pid ? attend(project, who.session, who.pid, who.name, heard, who.started, who.stops, who.launch, who.server, who.untrusted, who.chat, who.version, who.person) : null
    // An untrusted run's session hears only its own message, and a chat only its chat, so neither is someone there to
    // hear the owner's signals.
    const narrow = who.untrusted || !!who.started?.untrusted || who.chat || !!who.started?.chat
    const stopListening = heard && !narrow ? listen(project) : () => {}
    const done = () => {
        stopListening()
        attended?.done()
    }

    const api = `${origin}/api/projects/${encodeURIComponent(project)}`

    /** The signal with what the session needs to act on it (signal-payload.ts). */
    const told = (signal: Signal) => signalPayload(store, project, signal, {api, me: who.session ? currentId(who.session) : undefined})
    // The owner's signals for every session, for one orrery picks, or for this one (by any id it has had); a receipt (delivered_to) isn't news.
    const ours = (signal: Signal) => aimedAt(signal, attended?.id)
    // A member's words reach only that member's sessions (ORR-658), at the receiver, so nothing that sends one can get past it.
    const heardFrom = (signal: Signal) => signal.protected || !!signal.person && signal.person === who.person
    const wanted = (signal: Signal) => signal.project === project && heardFrom(signal) && !signal.delivered_to.length && ours(signal)
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
        missed = from !== undefined ? (await store.listSignals(project, from)).filter(s => s.project === project && heardFrom(s) && ours(s)) : []
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
        project, person: who.person, attended, heard, missed, told, ours, wanted, mine, goLive, inOrder,
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

/** A signal as a stream says it: what the session needs to act on it, and the context it was started with. */
export type Told = Awaited<ReturnType<Feed['told']>> & {context?: string}

/** A server-sent event stream's sink: each signal as a `signal` event with its id. */
export const sseSink = (stream: {push: (message: {id?: string, event: string, data: string}) => unknown}) =>
    (signal: Signal, told: Told) => stream.push({id: String(signal.id), event: 'signal', data: JSON.stringify(told)})

/** Hands the feed's signals to `say`, one after another: what it missed and what it should hear as it connects
 * (scheduled work nobody heard, the owner's unanswered comments), then each as it's sent. Several feeds can share a
 * stream; `sseSink` sends them as server-sent events. */
export async function streamFeed(say: (signal: Signal, told: Told) => unknown, feed: Feed, name?: string) {
    const {project, attended, heard} = feed
    const store = useStore()
    /** The context the owner started this session with, for its channel to add: once a stream, with the first signal
     * that finds it. Its hook hands it the same on every SessionStart (its first, a `/clear`, a compaction), so this is
     * for a session whose hook didn't get through; every signal carrying it again only filled its context (ORR-543). */
    let contextSaid = false
    const context = () => {
        const given = !contextSaid && attended && sessionNow(attended.id)?.started?.context
        if (!given) return {}
        contextSaid = true
        return {context: contextBlock(given)}
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
        // The owner's comment orrery handed this session (nobody was on its issue) makes the issue this session's, so
        // their next comment on it comes here too and the thread keeps one voice (ORR-513).
        if (attended && signal.kind === 'comment' && !signal.target && signal.issue) {
            store.workedBy(project, signal.issue, attended.id).catch(error => console.error(`[orrery] tying ${signal.issue} to its session:`, error))
        }
        const extra = context()
        feed.inOrder(async () => {
            const told = {...await feed.told(signal), ...extra}
            // Kept for the Context page as the stream says it (ORR-549).
            if (attended) noteContext(attended.id, 'signal', [signal.kind, signal.issue ?? signal.chunk].filter(Boolean).join(' · '), JSON.stringify(told))
            return say(signal, told)
        })
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
            await store.carryUnanswered(project, attended.id, feed.person)
        }
    } catch (error) {
        console.error(`[orrery] catching ${project}'s stream up:`, error)
        // What it missed still goes, before the live feed: going live counts those as sent, so they'd be lost.
        if (!feed.live) {
            feed.missed.filter(feed.mine).forEach(push)
            feed.goLive(send, new Set(feed.missed.map(s => s.id)))
        }
    }
}

/** Who a stream's query says is listening. The launch a session orrery started says it's for (`started`) goes with
 * its project's feed only (`launchedHere`), and is looked up once. */
export function listenerOf(text: (key: string) => string | undefined, launchedHere = true, person?: string): Listener {
    const launch = launchedHere ? text('started') : undefined
    return {
        session: text('session'), pid: Number(text('pid')) || undefined, name: text('name'), heard: text('channel') !== 'no',
        started: launch ? launched(launch) : undefined, launch, stops: text('stops') === 'yes', server: text('server'),
        untrusted: text('untrusted') === 'yes',
        chat: text('chat') === 'yes',
        version: text('version')?.slice(0, 40),
        ...person ? {person} : {},
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
