import type {Signal} from '#shared/roadmap'
import {CLOSED} from '#shared/roadmap'
import {renderPrompt} from '#shared/prompt'

// `GET /api/projects/:project/signals/stream` → the owner's signals to this project's sessions, as they're
// sent: server-sent `signal` events (each an id, so a reconnect with `Last-Event-ID` or `?after=` gets
// what it missed), or with `?format=text` one plain line each, for Claude Code's Monitor tool. Each
// open stream counts as a listening session.
export default defineEventHandler(async event => {
    const project = param(event, 'project')
    const store = useStore()
    await store.project(project)
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

    // The API as the session reaches it, for the addresses in a focus.
    const api = `${getRequestURL(event).origin}/api/projects/${encodeURIComponent(project)}`

    /** The signal with what a session needs to act on it: for a chunk, its open issues (or those of its
     * `status`), most urgent first. Columns go by their statuses' names. A focus comes with its `prompt`:
     * the project's (or the Orrery's) template filled in, with the standing instructions picked for it. */
    const told = async (signal: Signal) => {
        const statuses = await store.statuses()
        const templates = await store.prompts(project)
        const where = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(', ')
        const name = (column: string) => column === 'proposed' ? 'Proposed' : statuses.find(s => s.id === column)?.name ?? column
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
            // `none`: the issues in no chunk, which the board keeps as a chunk without an id.
            const chunk = signal.chunk === 'none'
                ? (await store.project(project)).board.chunks.find(c => !c.id) ?? {title: 'No chunk', column: 'done', priority: undefined, tasks: []}
                : await store.chunk(project, signal.chunk!)
            // A status, or a kind (`started`): its issues; else every open one.
            const fits = (t: {column: string, kind: string}) => signal.status
                ? t.column === signal.status || t.kind === signal.status
                : t.kind !== 'proposed' && !CLOSED.includes(t.kind as never)
            const open = chunk.tasks.filter(fits)
                .sort((a, b) => (a.priority ?? 'P9').localeCompare(b.priority ?? 'P9'))
                .map(t => ({id: t.id, title: t.title, column: name(t.column), priority: t.priority ?? null}))
            const status = signal.status ? statuses.find(s => s.id === signal.status)?.name ?? signal.status : undefined
            const prompt = renderPrompt(templates.chunk, {
                actor: signal.createdBy, chunk: signal.chunk, title: chunk.title, status: status ?? 'open', priority: chunk.priority,
                where: where(name(chunk.column), chunk.priority), note: signal.note,
                issues: open.map(i => `- ${i.id}: ${i.title} [${where(i.column, i.priority)}]`).join('\n') || '- none left',
                url: signal.chunk === 'none' ? `'${api}/issues?chunk=none'` : `${api}/chunks/${encodeURIComponent(signal.chunk!)}`,
            }, signal.instructions)
            return {...signal, status, title: chunk.title, column: name(chunk.column), priority: chunk.priority ?? null, chunk: chunk.title, issues: open, prompt}
        }
        const issue = await store.issue(project, signal.issue)
        const chunk = (await store.project(project)).board.chunks.find(c => c.id === (issue.chunk ?? ''))
        if (signal.kind !== 'focus') return {...signal, title: issue.title, column: name(issue.column), priority: issue.priority ?? null, chunk: chunk?.title ?? null}
        const prompt = renderPrompt(templates.focus, {
            actor: signal.createdBy, issue: issue.id, title: issue.title, status: name(issue.column), priority: issue.priority, chunk: chunk?.title,
            where: where(name(issue.column), issue.priority, chunk?.title), note: signal.note, url: `${api}/issues/${encodeURIComponent(issue.id)}`,
        }, signal.instructions)
        return {...signal, title: issue.title, column: name(issue.column), priority: issue.priority ?? null, chunk: chunk?.title ?? null, prompt}
    }
    // The owner's signals for every session, or for this one; a receipt (deliveredTo) isn't news.
    const wanted = (signal: Signal) => signal.project === project && signal.protected && !signal.deliveredTo.length
        && (!signal.target || signal.target === attended?.id)
    const missed = after ? (await store.listSignals(project, after)).filter(s => s.project === project && s.protected && (!s.target || s.target === attended?.id)) : []

    /** Sends signals one after another, in the order they came, however long each takes to read. */
    let queue: Promise<unknown> = Promise.resolve()
    const inOrder = (work: () => Promise<unknown>) => {
        queue = queue.then(work).catch(error => console.error(`[orrery] a signal for ${project}:`, error))
    }

    if (query.format === 'text') {
        const line = async (signal: Signal) => {
            const s = await told(signal)
            if (s.kind === 'message') return `${s.createdBy}'s schedule "${s.title}": ${(s.note ?? '').replace(/\s+/g, ' ')}\n`
            if (s.kind === 'comment') return `${s.createdBy} commented on ${s.issue} (${s.title}): ${(s.note ?? '').replace(/\s+/g, ' ')}\n`
            return `${'prompt' in s ? s.prompt.replace(/\s*\n+\s*/g, ' ') : s.title}\n`
        }
        let send: (signal: Signal) => void = () => {}
        const stream = new ReadableStream<string>({
            start(controller) {
                controller.enqueue(`Listening for focus signals on ${project}.\n`)
                missed.forEach(s => inOrder(async () => controller.enqueue(await line(s))))
                send = signal => wanted(signal) && inOrder(async () => controller.enqueue(await line(signal)))
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
    const push = (signal: Signal) => inOrder(async () => stream.push({id: String(signal.id), event: 'signal', data: JSON.stringify(await told(signal))}))
    const send = (signal: Signal) => wanted(signal) && push(signal)
    projectEvents.on('signal', send)
    const ping = setInterval(() => stream.push({event: 'ping', data: ''}), 25_000)
    stream.push({event: 'ready', data: JSON.stringify({project, listeners: listening(project)})})
    missed.forEach(push)
    // A session that can hear catches up on the owner's comments nobody has answered yet, and on
    // scheduled work nobody was there to hear.
    if (attended && heard) {
        await store.carryUnanswered(project, attended.id)
        const unheard = await store.unheardScheduled(project)
        unheard.filter(s => !missed.some(m => m.id === s.id)).forEach(push)
    }
    stream.onClosed(async () => {
        clearInterval(ping)
        projectEvents.off('signal', send)
        done()
        await stream.close()
    })
    return stream.send()
})
