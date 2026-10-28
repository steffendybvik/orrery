// `POST /api/events/log` {message, stack?, page?, build?, kind?} → 201 the event, or 204 when it isn't kept: an
// error in the page (Vue's error handler, `window.onerror`, a promise nobody caught), which the page sends itself.
// `kind` is `page.error` unless it says another under `page.`.
export default defineEventHandler(async event => {
    const body = ((await readBody(event).catch(() => null)) ?? {}) as Record<string, unknown>
    if (typeof body.message !== 'string' || !body.message.trim()) throw badRequest('Send {message}: what went wrong in the page')
    const kind = typeof body.kind === 'string' && body.kind ? body.kind : 'page.error'
    if (!kind.startsWith('page.')) throw badRequest(`"kind" is "${kind}"; the page logs kinds under page., e.g. page.error`)
    const text = (key: string) => typeof body[key] === 'string' ? {[key]: body[key]} : {}
    const logged = await useEventLog().record({level: 'error', kind, message: body.message, details: {...text('stack'), ...text('page'), ...text('build')}})
    if (!logged) return deleted(event)
    return created(event, logged)
})
