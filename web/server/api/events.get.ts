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
export default defineEventHandler(async event => {
    // A member who isn't the owner hears only the boards they can see, and none of what's the owner's own (the bell,
    // chats, secrets, the event log, the settings): ORR-1195. Which boards is asked of the API as them, again each minute.
    let seen = new Set<string>()
    const {member, sees, ownersToo} = streamHearing(event.context?.who as Who | undefined, () => seen)
    const look = async () => {
        const projects = await readAsAsker<{id: string}[]>(event, '/api/projects?every=1')
        seen = new Set((projects ?? []).map(p => p.id))
    }
    if (member) await look()
    const looking = member ? setInterval(look, 60_000) : undefined
    const owners = (send: (data: unknown) => void) => (data: unknown) => ownersToo && send(data)
    const stream = createEventStream(event)
    const patches = !!getQuery(event).patch
    const onProject = (project: Project) => sees(project.id) && stream.push({event: 'project', data: JSON.stringify(project)})
    const onPatch = (patch: ProjectPatch) => sees(patch.id) && stream.push({event: 'patch', data: JSON.stringify(patch)})
    const onRemoved = (id: string) => sees(id) && stream.push({event: 'removed', data: id})
    const onListeners = (project: string) => sees(project) && stream.push({event: 'listeners', data: JSON.stringify({project, count: listening(project)})})
    const onLaunchers = (project: string) => sees(project) && stream.push({event: 'launchers', data: JSON.stringify({project, count: launchersOf(project)})})
    const onSessions = (project: string) => sees(project) && stream.push({event: 'sessions', data: JSON.stringify({project, sessions: listSessions(project)})})
    const onSignal = (signal: Signal) => sees(signal.project) && stream.push({event: 'signal', data: JSON.stringify(signal)})
    const onNotice = owners((notice: unknown) => stream.push({event: 'notice', data: JSON.stringify(notice)}))
    const onSettings = owners((settings: unknown) => stream.push({event: 'settings', data: JSON.stringify(settings)}))
    const onSecrets = owners((secrets: unknown) => stream.push({event: 'secrets', data: JSON.stringify(secrets)}))
    const onLogged = owners((logged: unknown) => stream.push({event: 'logged', data: JSON.stringify(logged)}))
    const onChat = owners((chat: unknown) => stream.push({event: 'chat', data: JSON.stringify(chat)}))
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
        if (looking) clearInterval(looking)
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
