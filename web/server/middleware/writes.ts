// There are no accounts, so Orrery guards against the browser being used against it. Any website open
// in the owner's browser could otherwise post a form here and plant issues or comments for the sessions
// to read, or point its own domain at this machine (DNS rebinding) to read the board and write to it.
//
// - Only the names this machine goes by are answered: localhost (and *.localhost), an IP address, or
//   one listed in NUXT_ALLOWED_HOSTS (ORRERY_ALLOWED_HOSTS in compose), e.g. `orrery.lan`.
// - A write from a page on another site (its `Origin`) is refused; agents, curl and the channel send none.
// - A write's body must be JSON, which a page on another site can't send without the browser asking
//   first, and Orrery never says yes.
// - The sessions' streams (`…/signals/stream`, `…/launches/stream`) change what Orrery thinks is listening
//   just by being opened, so they're guarded like a write; and since a picture (`<img>`, an agent's
//   Markdown image) sends no Origin, a browser opening one has to be Orrery's own page, as an EventSource.
//   The channel, the launcher and curl send no Sec-Fetch headers.
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const STREAM = /^\/api\/(projects\/[^/]+\/(signals|launches)|signals)\/stream(\?|$)/
const LOCAL = /^(localhost|.+\.localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i

export default defineEventHandler(event => {
    const host = getRequestHost(event)
    const name = host.replace(/:\d+$/, '')
    const allowed = String(useRuntimeConfig().allowedHosts ?? '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean)
    if (!LOCAL.test(name) && !allowed.includes(name.toLowerCase())) {
        throw createError({statusCode: 403, statusMessage: `Orrery doesn't answer to "${name}"; add it to NUXT_ALLOWED_HOSTS`})
    }

    const stream = STREAM.test(event.path)
    if (!(WRITES.has(event.method) && event.path.startsWith('/api/')) && !stream) return
    const origin = getHeader(event, 'origin')
    if (origin && (origin === 'null' || hostOf(origin) !== host)) {
        throw createError({statusCode: 403, statusMessage: "Orrery takes writes from its own page, not another site's"})
    }
    if (stream) {
        const site = getHeader(event, 'sec-fetch-site')
        const dest = getHeader(event, 'sec-fetch-dest')
        if ((site && site !== 'same-origin' && site !== 'none') || (dest && dest !== 'empty')) {
            throw createError({statusCode: 403, statusMessage: "A session's stream is for its channel, not a page"})
        }
        return
    }
    const hasBody = Number(getHeader(event, 'content-length') ?? 0) > 0 || !!getHeader(event, 'transfer-encoding')
    if (hasBody && !(getHeader(event, 'content-type') ?? '').toLowerCase().startsWith('application/json')) {
        throw createError({statusCode: 415, statusMessage: 'Send the body as JSON (Content-Type: application/json)'})
    }
})

/** The host of an `Origin`, or nothing when it isn't a URL (`Origin: foo`), which then matches no host. */
function hostOf(origin: string): string | undefined {
    try {
        return new URL(origin).host
    } catch {
        return undefined
    }
}
