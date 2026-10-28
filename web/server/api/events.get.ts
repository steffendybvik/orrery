import type {Project, Signal} from '#shared/roadmap'

// `GET /api/events` → server-sent events: `project` (a project read again, as JSON) when its
// roadmap changes, `removed` (its id) when it goes, and `listeners` ({project, count}) when a session
// starts or stops listening for its signals, `launchers` ({project, count}) when a launcher that starts
// sessions for it connects or goes, and `schedules` ({project, schedules}) when they change or
// run, `secrets` (the list, never a value) when they change or one is used, and `logged` ({event, fresh}) when the
// event log records or resolves one, and `chat` (the chat) when one of the owner's chats changes or ends, so open
// pages update without a reload.
export default defineEventHandler(async event => {
    const stream = createEventStream(event)
    const onProject = (project: Project) => stream.push({event: 'project', data: JSON.stringify(project)})
    const onRemoved = (id: string) => stream.push({event: 'removed', data: id})
    const onListeners = (project: string) => stream.push({event: 'listeners', data: JSON.stringify({project, count: listening(project)})})
    const onLaunchers = (project: string) => stream.push({event: 'launchers', data: JSON.stringify({project, count: launchersOf(project)})})
    const onSessions = (project: string) => stream.push({event: 'sessions', data: JSON.stringify({project, sessions: listSessions(project)})})
    const onSignal = (signal: Signal) => stream.push({event: 'signal', data: JSON.stringify(signal)})
    const onNotice = (notice: unknown) => stream.push({event: 'notice', data: JSON.stringify(notice)})
    const onSettings = (settings: unknown) => stream.push({event: 'settings', data: JSON.stringify(settings)})
    const onSecrets = (secrets: unknown) => stream.push({event: 'secrets', data: JSON.stringify(secrets)})
    const onLogged = (logged: unknown) => stream.push({event: 'logged', data: JSON.stringify(logged)})
    const onChat = (chat: unknown) => stream.push({event: 'chat', data: JSON.stringify(chat)})
    const onSchedules = (project: string) => useScheduler().list(project)
        .then(schedules => stream.push({event: 'schedules', data: JSON.stringify({project, schedules})}), () => {})
    projectEvents.on('project', onProject)
    projectEvents.on('removed', onRemoved)
    projectEvents.on('listeners', onListeners)
    projectEvents.on('launchers', onLaunchers)
    projectEvents.on('sessions', onSessions)
    projectEvents.on('signal', onSignal)
    projectEvents.on('notice', onNotice)
    projectEvents.on('schedules', onSchedules)
    projectEvents.on('settings', onSettings)
    projectEvents.on('secrets', onSecrets)
    projectEvents.on('logged', onLogged)
    projectEvents.on('chat', onChat)
    // Keeps proxies and the browser from dropping a quiet connection.
    const ping = setInterval(() => stream.push({event: 'ping', data: ''}), 25_000)
    // The headers go out with the first event: without one, the browser waits to call it open. It
    // carries the build, so a tab left open across an update reloads into the new one.
    stream.push({event: 'ready', data: String(useRuntimeConfig().app.buildId ?? '')})

    stream.onClosed(async () => {
        clearInterval(ping)
        projectEvents.off('project', onProject)
        projectEvents.off('removed', onRemoved)
        projectEvents.off('listeners', onListeners)
        projectEvents.off('launchers', onLaunchers)
        projectEvents.off('sessions', onSessions)
        projectEvents.off('signal', onSignal)
        projectEvents.off('notice', onNotice)
        projectEvents.off('schedules', onSchedules)
        projectEvents.off('settings', onSettings)
        projectEvents.off('secrets', onSecrets)
        projectEvents.off('logged', onLogged)
        projectEvents.off('chat', onChat)
        await stream.close()
    })
    return stream.send()
})
