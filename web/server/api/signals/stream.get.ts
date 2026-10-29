import type {Feed} from '../../utils/signal-feed'

// `GET /api/signals/stream?projects=hub,css` (or `*`) → the owner's signals to a session on several projects, on one
// server-sent event stream: each `signal` event as `…/projects/:project/signals/stream` sends it (its `project` says
// whose), and `stop` when the owner stops the session. `*` follows every project, and each one made later too. The
// session counts as listening on each. `?after=` or `Last-Event-ID` catches up on every one of them (signal ids run
// across projects); a session orrery started names its project (`started_for`), whose feed takes its launch. `name`
// tells the session what orrery calls it, and again when that changes.
export default defineEventHandler(async event => {
    const query = getQuery(event)
    const text = (key: string) => typeof query[key] === 'string' && query[key] ? String(query[key]) : undefined
    const store = useStore()
    const asked = (text('projects') ?? '').split(',').map(p => p.trim()).filter(Boolean)
    if (!asked.length) throw badRequest('Say which projects: ?projects=hub,css, or * for every one')
    const every = asked.includes('*')
    const known = (await store.listProjects()).map(p => p.id)
    const projects = every ? known : asked
    const missing = projects.filter(p => !known.includes(p))
    if (missing.length) throw notFound(`No project ${missing.join(', ')}`)
    const from = query.after ?? getHeader(event, 'last-event-id')
    const after = from !== undefined ? Number(from) || 0 : undefined
    const origin = getRequestURL(event).origin
    const startedFor = text('started') ? text('started_for') ?? projects[0] : undefined

    const feeds: Feed[] = []
    const stream = createEventStream(event)
    let closed = false
    let unnamed: (() => void) | undefined
    let left = () => {}
    const add = async (project: string, catchUp: number | undefined) => {
        const feed = await openFeed(project, listenerOf(text, project === startedFor), catchUp, origin)
        if (closed) return feed.close()
        feeds.push(feed)
        // Its name before anything it catches up on.
        unnamed ??= sayName(stream, () => feeds.find(f => f.attended)?.attended?.id)
        await streamFeed(sseSink(stream), feed, text('name'))
    }
    // The owner stopping this session: its channel ends it.
    const stopped = (stop: {project: string, id: string}) => feeds.some(f => f.project === stop.project && f.attended?.id === stop.id)
        && stream.push({event: 'stop', data: JSON.stringify(stop)})
    projectEvents.on('session-stop', stopped)
    // With `*`, a project made later is followed from its first signal; one deleted is let go.
    const following = new Set(projects)
    const made = ({id}: {id: string}) => {
        if (!every || closed || following.has(id)) return
        following.add(id)
        add(id, 0).catch(error => console.error(`[orrery] following ${id}:`, error))
    }
    const removed = (id: string) => {
        const gone = feeds.findIndex(f => f.project === id)
        if (gone !== -1) feeds.splice(gone, 1)[0]?.close()
        following.delete(id)
    }
    projectEvents.on('project', made)
    projectEvents.on('removed', removed)
    const ping = setInterval(() => stream.push({event: 'ping', data: ''}), 25_000)
    stream.onClosed(async () => {
        closed = true
        clearInterval(ping)
        projectEvents.off('session-stop', stopped)
        projectEvents.off('project', made)
        projectEvents.off('removed', removed)
        unnamed?.()
        feeds.forEach(f => f.close())
        left()
        await stream.close()
    })
    stream.push({event: 'ready', data: JSON.stringify({projects, listeners: Object.fromEntries(projects.map(p => [p, listening(p)]))})})
    for (const project of projects) await add(project, after)
    if (!closed) left = noteChannel(projects, every, listenerOf(text, false), () => feeds.find(f => f.attended)?.attended?.id)
    return stream.send()
})
