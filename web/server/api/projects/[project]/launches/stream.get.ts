import type {LaunchEvent} from '../../../../utils/launches'

// `GET /api/projects/:project/launches/stream?dir=&every=1&version=&picked=` → server-sent events for the project's launcher
// (channel/orrery-launcher.mjs) on the host, running in the folder `dir` (projects served from one folder can share a
// session), with `every` where its channel serves every project (`*`), `version` its code's, `picked` when its channel picked the repo up (ORR-605), and `connected` when Connect a repo added it (ORR-774): `ready` {project, starts,
// version, token}, the orrery's version among them, and the token its claims send (`Orrery-Launcher`), so a launcher on older code knows to restart once it can; then each of the project's launches no launcher has taken yet; `launch` {id, project, after, minutes?, tmux, context?, hears?}, a session to start
// once it has claimed it (no minutes: until stopped); `stop` {id}, one of its sessions to stop (the owner stopped
// it, or it's done and its time is up or it sat idle too long); `extend` {id, stops_at}, the owner giving one longer; `clear` {id}, one of its sessions done with a piece of work, to `/clear` for a fresh context; `watch` {id, terminal}, the owner pressing Watch, to open a terminal on it in that app; `view` {id}, the owner viewing its screen, to send it (POST …/screen) until nobody is.
export default defineEventHandler(async event => {
    const project = param(event, 'project')
    const starts = await useStore().starts(project)
    const stream = createEventStream(event)
    const {dir, every, version, picked, connected} = getQuery(event)
    // Kept only as a time, so nothing else a launcher says reaches the page through it.
    const when = (at: unknown) => typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : undefined
    const [pickedAt, connectedAt] = [when(picked), when(connected)]
    const done = addLauncher(project, typeof dir === 'string' && dir ? dir : undefined, every === '1', typeof version === 'string' ? version.slice(0, 40) : '', {...pickedAt ? {picked_at: pickedAt} : {}, ...connectedAt ? {connected_at: connectedAt} : {}})
    const where = typeof dir === 'string' && dir ? {dir} : {}
    useEventLog().note({level: 'info', kind: 'launcher.connected', project, message: 'A launcher connected', details: where})
    const send = (sent: LaunchEvent) => {
        if (sent.type === 'launch') {
            if (sent.launch.project === project) stream.push({id: sent.launch.id, event: 'launch', data: JSON.stringify(sent.launch)})
        } else if (sent.project === project) {
            const {type, ...data} = sent
            stream.push({event: type, data: JSON.stringify(data)})
        }
    }
    projectEvents.on('launches', send)
    const ping = setInterval(() => stream.push({event: 'ping', data: ''}), 25_000)
    stream.push({event: 'ready', data: JSON.stringify({project, starts: starts ?? null, version: useRuntimeConfig().public.version, token: done.token})})
    // What no launcher has taken yet, such as a launch refused for an outdated launcher that has now restarted (ORR-471).
    for (const launch of unclaimedLaunches(project)) stream.push({id: launch.id, event: 'launch', data: JSON.stringify(launch)})
    stream.onClosed(async () => {
        clearInterval(ping)
        projectEvents.off('launches', send)
        done()
        useEventLog().note({level: 'info', kind: 'launcher.gone', project, message: 'A launcher went', details: where})
        await stream.close()
    })
    return stream.send()
})
