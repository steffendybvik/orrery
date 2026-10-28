// `POST /api/events/log` {message, stack?, page?, build?, kind?} → 201 the event, or 204 when it isn't kept: an
// error in the page (Vue's error handler, `window.onerror`, a promise nobody caught), which the page sends itself.
// `kind` is `page.error` unless it says another under `page.`. Anyone can send one, so it's kept as a report
// (`details.reported`), and at most PER_KIND a minute of a kind and ALL a minute in all are taken from each sender (a
// 429 past that), and EVERYONE from all of them, so nobody can push the older errors out of the log with them
// (ORR-420), nor use up what the page itself may send (ORR-457). A sender is where it's from, and whether it names itself
// (`Orrery-Actor`; the page sends none): every name from one address counts as one, so changing it gets no new
// allowance (ORR-483).
const PER_KIND = 5
const ALL = 20
const EVERYONE = 100
let minute = 0
const counts = new Map<string, number>()

export default defineEventHandler(async event => {
    const body = ((await readBody(event).catch(() => null)) ?? {}) as Record<string, unknown>
    if (typeof body.message !== 'string' || !body.message.trim()) throw badRequest('Send {message}: what went wrong in the page')
    const kind = typeof body.kind === 'string' && body.kind ? body.kind : 'page.error'
    if (!kind.startsWith('page.')) throw badRequest(`"kind" is "${kind}"; the page logs kinds under page., e.g. page.error`)
    const now = Math.floor(Date.now() / 60_000)
    if (now !== minute) {
        minute = now
        counts.clear()
    }
    const sender = `${getHeader(event, 'orrery-actor') === undefined ? 'page' : 'named'}@${event.node.req.socket?.remoteAddress ?? ''}`
    const [everyone, all, ofKind] = [counts.get('') ?? 0, counts.get(sender) ?? 0, counts.get(`${sender} ${kind}`) ?? 0]
    if (everyone >= EVERYONE || all >= ALL || ofKind >= PER_KIND) {
        const sent = everyone >= EVERYONE ? `Pages have sent ${EVERYONE} errors` : `This page has sent ${all >= ALL ? `${ALL} errors` : `${PER_KIND} ${kind}`}`
        throw createError({statusCode: 429, statusMessage: 'Too Many Requests', message: `${sent} this minute: try again in the next`})
    }
    counts.set('', everyone + 1).set(sender, all + 1).set(`${sender} ${kind}`, ofKind + 1)
    const text = (key: string) => typeof body[key] === 'string' ? {[key]: body[key]} : {}
    const logged = await useEventLog().record({level: 'error', kind, message: body.message, details: {...text('stack'), ...text('page'), ...text('build'), reported: true}})
    if (!logged) return deleted(event)
    return created(event, logged)
})
