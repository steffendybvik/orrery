import type {Told} from '../../../../utils/signal-feed'

// `GET /api/projects/:project/signals/stream` → the owner's signals to this project's sessions, as they're
// sent: server-sent `signal` events, `name` (what orrery calls the session, and again when that changes) (each an id, so a reconnect with `Last-Event-ID` or `?after=` gets
// what it missed), and `stop` when the owner stops the session; or with `?format=text` one plain line each, for Claude Code's Monitor tool. Each
// open stream counts as a listening session. A channel on several projects can follow them all on one stream
// instead (`/api/signals/stream`); both go through signal-feed.ts.
export default defineEventHandler(async event => {
    const project = param(event, 'project')
    const query = getQuery(event)
    // An `after` of 0 is a catch-up too: from a project's first signal, as a session started for it asks.
    const from = query.after ?? getHeader(event, 'last-event-id')
    const text = (key: string) => typeof query[key] === 'string' && query[key] ? String(query[key]) : undefined
    const who = listenerOf(text)
    const feed = await openFeed(project, who, from !== undefined ? Number(from) || 0 : undefined, getRequestURL(event).origin)
    const left = noteChannel([project], false, who, () => feed.attended?.id)

    if (query.format === 'text') {
        const line = (s: Told) => {
            if (s.kind === 'message') return `${s.created_by}${s.title ? `'s schedule "${s.title}"` : ' (to you)'}: ${(s.note ?? '').replace(/\s+/g, ' ')}\n`
            if (s.kind === 'comment') return `${s.created_by} commented on ${s.issue} (${s.title}): ${(s.note ?? '').replace(/\s+/g, ' ')}\n`
            return `${'prompt' in s ? s.prompt.replace(/\s*\n+\s*/g, ' ') : s.title}\n`
        }
        let lines!: ReadableStreamDefaultController<string>
        const stream = new ReadableStream<string>({
            start(controller) {
                lines = controller
                controller.enqueue(`Listening for focus signals on ${project}.\n`)
            },
            cancel() {
                feed.close()
            },
        })
        event.node.req.on('close', () => {
            feed.close()
            left()
        })
        await streamFeed((_, told) => lines.enqueue(line(told)), feed, text('name'))
        setResponseHeaders(event, {'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache'})
        return sendStream(event, stream.pipeThrough(new TextEncoderStream()))
    }

    const stream = createEventStream(event)
    // The owner stopping this session: its channel ends it.
    const stopped = (asked: {project: string, id: string}) => asked.project === project && asked.id === feed.attended?.id
        && stream.push({event: 'stop', data: JSON.stringify(asked)})
    projectEvents.on('session-stop', stopped)
    const ping = setInterval(() => stream.push({event: 'ping', data: ''}), 25_000)
    let unnamed = () => {}
    // Cleaned up however the stream ends, a catch-up that fails included.
    stream.onClosed(async () => {
        clearInterval(ping)
        unnamed()
        projectEvents.off('session-stop', stopped)
        feed.close()
        left()
        await stream.close()
    })
    stream.push({event: 'ready', data: JSON.stringify({project, listeners: listening(project)})})
    unnamed = sayName(stream, () => feed.attended?.id)
    await streamFeed(sseSink(stream), feed, text('name'))
    return stream.send()
})
