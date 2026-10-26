import type {LaunchEvent} from '../../../../utils/launches'

// `GET /api/projects/:project/launches/stream` → server-sent events for the project's launcher
// (channel/orrery-launcher.mjs) on the host: `launch` {id, project, after, minutes?, tmux, context?}, a session to start
// once it has claimed it (no minutes: until stopped); `stop` {id}, one of its sessions to stop (the owner stopped
// it, or it's done and its time is up or it sat idle too long); `extend` {id, stops_at}, the owner giving one longer; `clear` {id}, one of its sessions done with a piece of work, to `/clear` for a fresh context; `watch` {id, terminal}, the owner pressing Watch, to open a terminal on it in that app; `view` {id}, the owner viewing its screen, to send it (POST …/screen, with the key `ready` gave it) until nobody is.
export default defineEventHandler(async event => {
    const project = param(event, 'project')
    const starts = await useStore().starts(project)
    const stream = createEventStream(event)
    const done = addLauncher(project)
    const {key, drop} = keyLauncher(project)
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
    stream.push({event: 'ready', data: JSON.stringify({project, starts: starts ?? null, key})})
    stream.onClosed(async () => {
        clearInterval(ping)
        projectEvents.off('launches', send)
        done()
        drop()
        await stream.close()
    })
    return stream.send()
})
