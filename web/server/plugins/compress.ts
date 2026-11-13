import {gzipSync} from 'node:zlib'
import {appendResponseHeader, getRequestHeader, getResponseHeader, setResponseHeader, type H3Event} from 'h3'

// API answers go gzipped to a browser that takes it, as nothing in front of orrery does that for it (ORR-766): on
// anything but loopback that's about a fifth off a cold load, `/api/projects` going from about 1 MB to 93 kB on a big
// board. Only what a handler returns as a value is compressed here, once h3 would turn it into JSON: streams (the events
// feed, a session's screen), files and errors go as they are. The public files are compressed at build instead
// (`nitro.compressPublicAssets`).

/** Smaller than this, gzip's header and the work cost more than they save. */
const MIN_BYTES = 1024

/** The body to send in place of `body`, gzipped, or undefined to leave it as it is. */
export function compressed(event: H3Event, body: unknown): Buffer | undefined {
    if (!event.path.startsWith('/api/') || event.handled || event.node.res.headersSent) return
    if (!/\bgzip\b/.test(getRequestHeader(event, 'accept-encoding') ?? '')) return
    if (getResponseHeader(event, 'content-encoding')) return
    const json = typeof body === 'object' && body !== null && !(body instanceof Error) && !('buffer' in body) && !('pipe' in body) && !('arrayBuffer' in body) && !('end' in body)
    if (!json) return
    const text = JSON.stringify(body)
    if (Buffer.byteLength(text) < MIN_BYTES) return
    if (!getResponseHeader(event, 'content-type')) setResponseHeader(event, 'content-type', 'application/json')
    setResponseHeader(event, 'content-encoding', 'gzip')
    appendResponseHeader(event, 'vary', 'Accept-Encoding')
    return gzipSync(text)
}

export default defineNitroPlugin(nitro => {
    nitro.hooks.hook('beforeResponse', (event, response) => {
        const gzipped = compressed(event, response.body)
        if (gzipped) response.body = gzipped
    })
})
