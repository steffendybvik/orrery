import type {Project, Signal} from '#shared/roadmap'
import type {ProjectPatch} from '#shared/patch'
import type {Who} from '../utils/auth'

// `GET /api/events` → server-sent events: `project` (a project read again, as JSON) when its
// roadmap changes (with `?patch=1`, `patch` instead: what changed in it, see shared/patch.ts, ORR-440), `removed` (its id) when it goes, and `listeners` ({project, count}) when a session
// starts or stops listening for its signals, `launchers` ({project, count}) when a launcher that starts
// sessions for it connects or goes, and `schedules` ({project, schedules}) when they change or
// run, `secrets` (the list, never a value) when they change or one is used, and `logged` ({event, fresh}) when the
// event log records or resolves one, `epics` (nothing: ask `/api/epics` again) when an epic is made, changed or
// deleted, and `chat` (the chat) when one of the owner's chats changes or ends, so open
// pages update without a reload.
// `?workspace=` names the tab's workspace, as an EventSource sends no headers: anyone signed in, the owner too, hears
// only the projects of that workspace they can see (ORR-1347), so no other person's project reaches their page.
export default defineEventHandler(async event => {
    // A member who isn't the owner hears none of what's the owner's own (the bell, secrets, the event log, the
    // settings): ORR-1195. Which boards is asked of the API as them, again each minute, and at once when a project
    // they haven't been told of yet changes (one made a moment ago).
    const named = getQuery(event).workspace
    const workspace = typeof named === 'string' && named ? named : undefined
    let seen: Set<string> | undefined = new Set<string>()
    const {held, sees, ownersToo, hearsNotice, hearsLogged} = streamHearing(event.context?.who as Who | undefined, () => seen, workspace)
    let looked = 0
    let looking: Promise<void> | undefined
    const look = (fresh = false) => looking ??= listedSees(event, {workspace, fresh})
        .then(projects => {
            // Undefined with login off alone: with no answer from the API, anyone signed in hears no board, the owner
            // too (ORR-1368), and an event about one is asked of the API again (`about`).
            seen = projects ?? (ownersToo ? undefined : new Set())
            looked = Date.now()
        }, () => {})
        .finally(() => looking = undefined)
    if (held) await look()
    const every = held ? setInterval(() => void look(true), 60_000) : undefined
    /** Sends what's about `project` once it's known to be seen: a project not seen yet is asked of the API again (at
     * most every few seconds), and its events wait for the answer in the order they came. */
    let queue = Promise.resolve()
    const about = (project: string | null | undefined, send: () => void) => {
        if (sees(project)) return void send()
        if (!held || !project) return
        queue = queue.then(async () => {
            if (Date.now() - looked > 5_000) await look(true)
            if (sees(project)) send()
        })
    }
    const owners = (send: (data: unknown) => void) => (data: unknown) => ownersToo && send(data)
    const stream = createEventStream(event)
    const patches = !!getQuery(event).patch
    const onProject = (project: Project) => about(project.id, () => stream.push({event: 'project', data: JSON.stringify(project)}))
    const onPatch = (patch: ProjectPatch) => about(patch.id, () => stream.push({event: 'patch', data: JSON.stringify(patch)}))
    const onRemoved = (id: string) => sees(id) && stream.push({event: 'removed', data: id})
    const onListeners = (project: string) => sees(project) && stream.push({event: 'listeners', data: JSON.stringify({project, count: listening(project)})})
    const onLaunchers = (project: string) => sees(project) && stream.push({event: 'launchers', data: JSON.stringify({project, count: launchersOf(project)})})
    const onSessions = (project: string) => sees(project) && stream.push({event: 'sessions', data: JSON.stringify({project, sessions: listSessions(project)})})
    const onSignal = (signal: Signal) => sees(signal.project) && stream.push({event: 'signal', data: JSON.stringify(signal)})
    // A bell's notice and an event log row go only with a project they see (ORR-1353): see streamHearing.
    const onNotice = (notice: unknown) => hearsNotice(notice) && stream.push({event: 'notice', data: JSON.stringify(notice)})
    const onSettings = owners((settings: unknown) => stream.push({event: 'settings', data: JSON.stringify(settings)}))
    const onSecrets = owners((secrets: unknown) => stream.push({event: 'secrets', data: JSON.stringify(secrets)}))
    const onLogged = (logged: unknown) => hearsLogged(logged) && stream.push({event: 'logged', data: JSON.stringify(logged)})
    const onChat = owners((chat: unknown) => sees((chat as {project?: string}).project) && stream.push({event: 'chat', data: JSON.stringify(chat)}))
    const onEpics = () => stream.push({event: 'epics', data: ''})
    const onSchedules = (project: string) => sees(project) && useScheduler().list(project)
        .then(schedules => stream.push({event: 'schedules', data: JSON.stringify({project, schedules})}), () => {})
    if (patches) projectEvents.on('patch', onPatch)
    else projectEvents.on('project', onProject)
    projectEvents.on('removed', onRemoved)
    projectEvents.on('listeners', onListeners)
    projectEvents.on('launchers', onLaunchers)
    projectEvents.on('sessions', onSessions)
    projectEvents.on('signal', onSignal)
    projectEvents.on('notice', onNotice)
    projectEvents.on('schedules', onSchedules)
    projectEvents.on('settings', onSettings)
    projectEvents.on('secrets', onSecrets)
    // A use moves the list's uses on: the page shows them, the same as a change.
    projectEvents.on('secret-used', onSecrets)
    projectEvents.on('logged', onLogged)
    projectEvents.on('chat', onChat)
    projectEvents.on('epics', onEpics)
    // Keeps proxies and the browser from dropping a quiet connection.
    const ping = setInterval(() => stream.push({event: 'ping', data: ''}), 25_000)
    // The headers go out with the first event: without one, the browser waits to call it open. It
    // carries the build, so a tab left open across an update reloads into the new one.
    stream.push({event: 'ready', data: String(useRuntimeConfig().app.buildId ?? '')})

    stream.onClosed(async () => {
        clearInterval(ping)
        if (every) clearInterval(every)
        projectEvents.off('project', onProject)
        projectEvents.off('patch', onPatch)
        projectEvents.off('removed', onRemoved)
        projectEvents.off('listeners', onListeners)
        projectEvents.off('launchers', onLaunchers)
        projectEvents.off('sessions', onSessions)
        projectEvents.off('signal', onSignal)
        projectEvents.off('notice', onNotice)
        projectEvents.off('schedules', onSchedules)
        projectEvents.off('settings', onSettings)
        projectEvents.off('secrets', onSecrets)
        projectEvents.off('secret-used', onSecrets)
        projectEvents.off('logged', onLogged)
        projectEvents.off('chat', onChat)
        projectEvents.off('epics', onEpics)
        await stream.close()
    })
    return stream.send()
})
