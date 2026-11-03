import {createServer} from 'node:http'
import {toNodeListener} from 'h3'

// The phone's own port (ORR-837, utils/phone-port.ts): the same app on a second listener, on every address, so a phone on
// the network reaches it while the main one stays where it was. Every request on it asks for a login (`authMode`).
export default defineNitroPlugin(nitroApp => {
    const port = phoneListenPort()
    if (!port) return
    const server = createServer(toNodeListener(nitroApp.h3App))
    server.on('error', error => useEventLog().note({level: 'error', kind: 'phone.listen', message: `The phone's port (${port}) couldn't open: ${error.message}`, details: {port}}))
    server.listen(port, '0.0.0.0')
    nitroApp.hooks.hook('close', () => new Promise<void>(resolve => server.close(() => resolve())))
})
