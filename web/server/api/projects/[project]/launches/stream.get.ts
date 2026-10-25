import type {Launch} from '../../../../utils/launches'

// `GET /api/projects/:project/launches/stream` → server-sent `launch` events, {id, project, after, minutes}: the
// sessions Orrery wants started for the project, for its launcher (channel/orrery-launcher.mjs) on the host.
export default defineEventHandler(async event => {
    const project = param(event, 'project')
    const {starts} = await useStore().project(project)
    const stream = createEventStream(event)
    const done = addLauncher(project)
    const send = (launch: Launch) => launch.project === project && stream.push({id: launch.id, event: 'launch', data: JSON.stringify(launch)})
    projectEvents.on('launch', send)
    const ping = setInterval(() => stream.push({event: 'ping', data: ''}), 25_000)
    stream.push({event: 'ready', data: JSON.stringify({project, starts: starts ?? null})})
    stream.onClosed(async () => {
        clearInterval(ping)
        projectEvents.off('launch', send)
        done()
        await stream.close()
    })
    return stream.send()
})
