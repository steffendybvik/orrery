import type {ConnectEvent} from '../../utils/connects'

// `GET /api/connects/stream?host=&addresses=&local=` → server-sent events for a launcher service that can open a folder picker on its machine
// (ORR-708), one stream per orrery, whatever it serves: `ready` {token, orrery}, the token for what it reports; `pick` {id}, the
// owner asking for a folder; `write` {id, projects, orrery, terminal}, the projects to set the folder it chose up with. That a
// launcher has this stream is what says it can do this, so an older one is never asked. On a server with several people it's
// the owner's alone. `addresses` are its machine's IPv4 addresses on its networks, comma-separated, for App settings' link
// to open orrery on a phone (ORR-833), and `local` its Bonjour name, `<name>.local` (ORR-874).
export default defineEventHandler(async event => {
    const who = event.context?.who
    const named = getHeader(event, 'orrery-person')
    if (who ? !who.owner : named && named !== (await useStore().ownerOf()).name) throw forbidden('Only the owner\'s launcher can be asked to connect a repo')
    const {id} = await useStore().settings()
    const {host, addresses, local} = getQuery(event)
    const stream = createEventStream(event)
    const done = addPicker(typeof host === 'string' ? host.slice(0, 100) : '', ipv4List(addresses), bonjourName(local))
    const send = (sent: ConnectEvent) => {
        if (sent.type === 'write' && sent.token !== done.token) return
        const {type, ...data} = sent
        const {token: _, ...said} = data as typeof data & {token?: string}
        stream.push({event: type, data: JSON.stringify(said)})
    }
    projectEvents.on('connects', send)
    const ping = setInterval(() => stream.push({event: 'ping', data: ''}), 25_000)
    stream.push({event: 'ready', data: JSON.stringify({token: done.token, orrery: id})})
    stream.onClosed(async () => {
        clearInterval(ping)
        projectEvents.off('connects', send)
        done()
        await stream.close()
    })
    return stream.send()
})
