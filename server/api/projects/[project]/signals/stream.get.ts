import type {Signal} from '#shared/roadmap'

// `GET /api/projects/:project/signals/stream` → the owner's signals to this project's sessions, as they're
// sent: server-sent `signal` events (each an id, so a reconnect with `Last-Event-ID` or `?after=` gets
// what it missed), or with `?format=text` one plain line each, for Claude Code's Monitor tool. Each
// open stream counts as a listening session.
export default defineEventHandler(event => {
    const project = param(event, 'project')
    const store = useStore()
    store.project(project)
    const query = getQuery(event)
    const after = Number(query.after ?? getHeader(event, 'last-event-id') ?? 0) || 0
    const text = (key: string) => typeof query[key] === 'string' && query[key] ? String(query[key]) : undefined
    // A channel says which window it is; the Monitor stream may not.
    // A channel in a session not started with the channel flag says so (`channel=no`): Claude Code
    // drops its messages, so the session isn't counted as listening.
    const heard = text('channel') !== 'no'
    const attended = text('session') || text('pid') ? attend(project, text('session'), Number(text('pid')) || undefined, text('name'), heard) : null
    const stopListening = heard ? listen(project) : () => {}
    const done = () => {
        stopListening()
        attended?.done()
    }

    /** The signal with what a session needs to act on it: for a chunk, its open issues, most urgent first. */
    const told = (signal: Signal) => {
        if (!signal.issue) {
            // `none`: the issues in no chunk, which the board keeps as a chunk without an id.
            const chunk = signal.chunk === 'none'
                ? store.project(project).board.chunks.find(c => !c.id) ?? {title: 'No chunk', column: 'done' as const, priority: undefined, tasks: []}
                : store.chunk(project, signal.chunk!)
            const open = chunk.tasks.filter(t => t.column !== 'done')
                .sort((a, b) => (a.priority ?? 'P9').localeCompare(b.priority ?? 'P9'))
                .map(t => ({id: t.id, title: t.title, column: t.column, priority: t.priority ?? null}))
            return {...signal, title: chunk.title, column: chunk.column, priority: chunk.priority ?? null, chunk: chunk.title, issues: open}
        }
        const issue = store.issue(project, signal.issue)
        const chunk = store.project(project).board.chunks.find(c => c.id === (issue.chunk ?? ''))
        return {...signal, title: issue.title, column: issue.column, priority: issue.priority ?? null, chunk: chunk?.title ?? null}
    }
    // The owner's signals for every session, or for this one; a receipt (deliveredTo) isn't news.
    const wanted = (signal: Signal) => signal.project === project && signal.protected && !signal.deliveredTo.length
        && (!signal.target || signal.target === attended?.id)
    const missed = after ? store.listSignals(project, after).filter(s => s.project === project && s.protected && (!s.target || s.target === attended?.id)) : []

    if (query.format === 'text') {
        const line = (signal: Signal) => {
            const s = told(signal)
            if (s.kind === 'comment') return `${s.createdBy} commented on ${s.issue} (${s.title}): ${(s.note ?? '').replace(/\s+/g, ' ')}\n`
            if ('issues' in s) return `${s.createdBy} asks you to work through chunk ${signal.chunk}: ${s.title} [${s.column}${s.priority ? `, ${s.priority}` : ''}], open: ${s.issues.map(i => i.id).join(', ') || 'none'}${s.note ? ` — ${s.note}` : ''}\n`
            return `${s.createdBy} asks you to focus on ${s.issue}: ${s.title} [${s.column}${s.priority ? `, ${s.priority}` : ''}${s.chunk ? `, ${s.chunk}` : ''}]${s.note ? ` — ${s.note}` : ''}\n`
        }
        let send: (signal: Signal) => void = () => {}
        const stream = new ReadableStream<string>({
            start(controller) {
                controller.enqueue(`Listening for focus signals on ${project}.\n`)
                missed.forEach(s => controller.enqueue(line(s)))
                send = signal => wanted(signal) && controller.enqueue(line(signal))
                projectEvents.on('signal', send)
            },
            cancel() {
                projectEvents.off('signal', send)
                done()
            },
        })
        event.node.req.on('close', () => {
            projectEvents.off('signal', send)
            done()
        })
        setResponseHeaders(event, {'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache'})
        return sendStream(event, stream.pipeThrough(new TextEncoderStream()))
    }

    const stream = createEventStream(event)
    const push = (signal: Signal) => stream.push({id: String(signal.id), event: 'signal', data: JSON.stringify(told(signal))})
    const send = (signal: Signal) => wanted(signal) && push(signal)
    projectEvents.on('signal', send)
    const ping = setInterval(() => stream.push({event: 'ping', data: ''}), 25_000)
    stream.push({event: 'ready', data: JSON.stringify({project, listeners: listening(project)})})
    missed.forEach(push)
    // A session that can hear catches up on the owner's comments nobody has answered yet.
    if (attended && heard) store.carryUnanswered(project, attended.id)
    stream.onClosed(async () => {
        clearInterval(ping)
        projectEvents.off('signal', send)
        done()
        await stream.close()
    })
    return stream.send()
})
