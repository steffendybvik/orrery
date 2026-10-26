import type {Signal} from '#shared/roadmap'
import {renderPrompt} from '#shared/prompt'

// `GET /api/projects/:project/signals/stream` → the owner's signals to this project's sessions, as they're
// sent: server-sent `signal` events (each an id, so a reconnect with `Last-Event-ID` or `?after=` gets
// what it missed), and `stop` when the owner stops the session; or with `?format=text` one plain line each, for Claude Code's Monitor tool. Each
// open stream counts as a listening session.
export default defineEventHandler(async event => {
    const project = param(event, 'project')
    const store = useStore()
    await store.project(project)
    const query = getQuery(event)
    // An `after` of 0 is a catch-up too: from a project's first signal, as a session started for it asks.
    const from = query.after ?? getHeader(event, 'last-event-id')
    const after = Number(from ?? 0) || 0
    const text = (key: string) => typeof query[key] === 'string' && query[key] ? String(query[key]) : undefined
    // A channel says which window it is; the Monitor stream may not.
    // A channel in a session not started with the channel flag says so (`channel=no`): Claude Code
    // drops its messages, so the session isn't counted as listening.
    const heard = text('channel') !== 'no'
    // A session Orrery started says which launch it is (`started`); a channel that quits when the owner stops
    // its session says so (`stops`); and the name its server goes by in the repo's .mcp.json, when it found it (`server`).
    const started = text('started') ? launched(text('started')!) : undefined
    const attended = text('session') || text('pid') ? attend(project, text('session'), Number(text('pid')) || undefined, text('name'), heard, started, text('stops') === 'yes', text('started'), text('server')) : null
    const stopListening = heard ? listen(project) : () => {}
    const done = () => {
        stopListening()
        attended?.done()
    }

    // The API as the session reaches it, for the addresses in a focus.
    const api = `${getRequestURL(event).origin}/api/projects/${encodeURIComponent(project)}`

    /** The signal with what a session needs to act on it: for a chunk, its open issues (or those of its
     * `status`), most urgent first. Columns go by their statuses' names. A focus comes with its `prompt`:
     * the project's (or the Orrery's) template filled in, with the standing instructions picked for it. */
    const told = async (signal: Signal) => {
        const statuses = await store.statuses()
        const templates = await store.prompts(project)
        const where = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(', ')
        const name = (column: string) => columnName(column, statuses)
        if (signal.kind === 'message' && signal.schedule === undefined) return {...signal, title: null, column: null, priority: null, chunk: null}
        if (signal.kind === 'message') {
            let title = 'a schedule'
            try {
                title = (await useScheduler().get(project, signal.schedule!)).title
            } catch {
                // The schedule is gone since; its message still stands.
            }
            return {...signal, title, column: null, priority: null, chunk: null}
        }
        if (!signal.issue) {
            const {chunk, title, wanted, open: matching} = await scopeOf(store, project, signal)
            const open = matching.map(t => ({id: t.id, title: t.title, column: t.column, priority: t.priority ?? null}))
            const status = wanted.length ? wanted.map(s => statuses.find(st => st.id === s)?.name ?? s).join(' or ') : undefined
            const query = new URLSearchParams({...signal.chunk === 'all' ? {} : {chunk: signal.chunk!}, ...signal.status ? {status: signal.status} : {}, ...signal.release ? {release: signal.release} : {}})
            const prompt = renderPrompt(templates.chunk, {
                actor: signal.created_by, chunk: signal.chunk, title, status: status ?? 'open', priority: chunk.priority,
                where: where(name(chunk.column), chunk.priority), note: signal.note,
                issues: open.map(i => issueLine(i, statuses)).join('\n') || '- none left',
                url: signal.chunk === 'none' || signal.chunk === 'all' || signal.release || signal.status?.includes(',')
                    ? `'${api}/issues?${query}'` : `${api}/chunks/${encodeURIComponent(signal.chunk!)}`,
            }, signal.instructions).replace(' []', '')
            return {...signal, status, title, column: name(chunk.column), priority: chunk.priority ?? null, chunk: title, issues: open.map(i => ({...i, column: name(i.column)})), prompt}
        }
        const issue = await store.issue(project, signal.issue)
        const chunk = (await store.project(project)).board.chunks.find(c => c.id === (issue.chunk ?? ''))
        if (signal.kind !== 'focus') return {...signal, title: issue.title, column: name(issue.column), priority: issue.priority ?? null, chunk: chunk?.title ?? null}
        const prompt = renderPrompt(templates.focus, {
            actor: signal.created_by, issue: issue.id, title: issue.title, status: name(issue.column), priority: issue.priority, chunk: chunk?.title,
            where: where(name(issue.column), issue.priority, chunk?.title), note: signal.note, url: `${api}/issues/${encodeURIComponent(issue.id)}`,
        }, signal.instructions)
        return {...signal, title: issue.title, column: name(issue.column), priority: issue.priority ?? null, chunk: chunk?.title ?? null, prompt}
    }
    // The owner's signals for every session, or for this one (by any id it has had); a receipt (delivered_to) isn't news.
    const ours = (signal: Signal) => !signal.target || currentId(signal.target) === attended?.id
    const wanted = (signal: Signal) => signal.project === project && signal.protected && !signal.delivered_to.length && ours(signal)
    // Live signals are heard from before the catch-up is read, and held until it has gone out, so one sent in
    // between isn't lost; `heard` takes them once it has (those in the catch-up too are left out).
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
        missed = from !== undefined ? (await store.listSignals(project, after)).filter(s => s.project === project && s.protected && ours(s)) : []
    } catch (error) {
        projectEvents.off('signal', hear)
        done()
        throw error
    }

    /** Sends signals one after another, in the order they came, however long each takes to read. */
    let queue: Promise<unknown> = Promise.resolve()
    const inOrder = (work: () => Promise<unknown>) => {
        queue = queue.then(work).catch(error => console.error(`[orrery] a signal for ${project}:`, error))
    }

    if (query.format === 'text') {
        const line = async (signal: Signal) => {
            const s = await told(signal)
            if (s.kind === 'message') return `${s.created_by}${s.title ? `'s schedule "${s.title}"` : ' (to you)'}: ${(s.note ?? '').replace(/\s+/g, ' ')}\n`
            if (s.kind === 'comment') return `${s.created_by} commented on ${s.issue} (${s.title}): ${(s.note ?? '').replace(/\s+/g, ' ')}\n`
            return `${'prompt' in s ? s.prompt.replace(/\s*\n+\s*/g, ' ') : s.title}\n`
        }
        const stream = new ReadableStream<string>({
            start(controller) {
                controller.enqueue(`Listening for focus signals on ${project}.\n`)
                missed.forEach(s => inOrder(async () => controller.enqueue(await line(s))))
                goLive(signal => wanted(signal) && inOrder(async () => controller.enqueue(await line(signal))), new Set(missed.map(s => s.id)))
            },
            cancel() {
                projectEvents.off('signal', hear)
                done()
            },
        })
        event.node.req.on('close', () => {
            projectEvents.off('signal', hear)
            done()
        })
        setResponseHeaders(event, {'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache'})
        return sendStream(event, stream.pipeThrough(new TextEncoderStream()))
    }

    const stream = createEventStream(event)
    // The owner stopping this session: its channel ends it.
    const stopped = (asked: {project: string, id: string}) => asked.project === project && asked.id === attended?.id
        && stream.push({event: 'stop', data: JSON.stringify(asked)})
    projectEvents.on('session-stop', stopped)
    const ping = setInterval(() => stream.push({event: 'ping', data: ''}), 25_000)
    // Cleaned up however the stream ends, a catch-up that fails included.
    stream.onClosed(async () => {
        clearInterval(ping)
        projectEvents.off('signal', hear)
        projectEvents.off('session-stop', stopped)
        done()
        await stream.close()
    })
    /** The context the owner started this session with, which every signal to it carries, for its channel to add. */
    const context = () => {
        const given = attended && sessionNow(attended.id)?.started?.context
        return given ? {context: contextBlock(given)} : {}
    }
    /** When each repeatable message last went out on this stream. */
    const sent = new Map<string, number>()
    const push = (signal: Signal) => {
        const key = repeatKey(signal)
        if (key) sent.set(key, Date.now())
        if (attended) startRun(attended.id, signal)
        inOrder(async () => stream.push({id: String(signal.id), event: 'signal', data: JSON.stringify({...await told(signal), ...context()})}))
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
        if (!wanted(signal)) return
        if (!unread(signal)) return push(signal)
        store.delivered(project, signal.id, sessionName(attended!.id) ?? text('name') ?? 'a session')
            .catch(error => console.error(`[orrery] a repeat for ${project}:`, error))
    }
    stream.push({event: 'ready', data: JSON.stringify({project, listeners: listening(project)})})
    // A session that can hear catches up on scheduled work nobody was there to hear, and on the owner's
    // comments nobody has answered yet. A failure there leaves the stream open for what comes next.
    try {
        const unheard = attended && heard ? (await store.unheardScheduled(project)).filter(ours) : []
        // A schedule that kept sending the same message while nobody heard it says it once; the copies count as heard.
        const backlog = [...missed, ...unheard.filter(s => !missed.some(m => m.id === s.id))]
        const {kept, repeats} = foldRepeats(backlog)
        kept.forEach(push)
        goLive(send, new Set(backlog.map(s => s.id)))
        if (attended && heard) {
            const name = sessionName(attended.id) ?? text('name') ?? 'a session'
            for (const s of repeats) await store.delivered(project, s.id, name)
            await store.carryUnanswered(project, attended.id)
        }
    } catch (error) {
        console.error(`[orrery] catching ${project}'s stream up:`, error)
        if (!live) goLive(send, new Set(missed.map(s => s.id)))
    }
    return stream.send()
})
