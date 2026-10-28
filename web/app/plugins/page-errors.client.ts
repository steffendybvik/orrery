// Sends the page's own errors to the event log (ORR-322): what Vue's error handler catches, `window.onerror`, and a
// promise nobody caught. A few a minute at most, and the same one once in a while, so a page stuck in a loop
// doesn't flood it; one that can't be sent is let go. A 404 isn't one: an old or mistyped link shows Not found
// (error.vue), and nothing went wrong in Orrery (ORR-369).
export default defineNuxtPlugin(nuxtApp => {
    const sent = new Map<string, number>()
    let minute = 0
    let inMinute = 0
    function send(error: unknown) {
        if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 404) return
        const message = error instanceof Error ? error.message : typeof error === 'string' ? error : (() => {
            try {
                return JSON.stringify(error)
            } catch {
                return String(error)
            }
        })()
        if (!message) return
        const now = Date.now()
        if (now - (sent.get(message) ?? -Infinity) < 60_000) return
        if (Math.floor(now / 60_000) !== minute) [minute, inMinute] = [Math.floor(now / 60_000), 0]
        if (++inMinute > 5) return
        sent.set(message, now)
        $fetch('/api/events/log', {method: 'POST', body: {
            message,
            ...error instanceof Error && error.stack ? {stack: error.stack} : {},
            page: location.pathname,
            build: String(useRuntimeConfig().app.buildId ?? ''),
        }}).catch(() => {})
    }
    nuxtApp.hook('vue:error', error => send(error))
    nuxtApp.hook('app:error', error => send(error))
    window.addEventListener('error', event => send(event.error ?? event.message))
    window.addEventListener('unhandledrejection', event => send(event.reason))
})
