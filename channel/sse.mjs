// Follows one of orrery's server-sent event streams for good, for the channel and the launcher: `url()` says
// where (asked again on each reconnect, so it can pick up where it left off), `onEvent({event, data, id})`
// hears each event in order, `onOpen()` each time it connects, and a drop reconnects after a growing wait. Aborting
// `signal` lets it go: the stream closes and it returns.
export async function follow({url, onEvent, onOpen = () => {}, log, signal}) {
    for (let wait = 1000; !signal?.aborted; wait = Math.min(wait * 2, 30_000)) {
        try {
            const response = await fetch(url(), {headers: {Accept: 'text/event-stream'}, signal})
            if (!response.ok || !response.body) throw new Error(`${response.status} ${response.statusText}`)
            onOpen()
            wait = 1000
            let buffer = ''
            for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
                buffer += chunk.replace(/\r\n?/g, '\n')
                let end
                while ((end = buffer.indexOf('\n\n')) >= 0) {
                    const block = buffer.slice(0, end)
                    buffer = buffer.slice(end + 2)
                    const field = name => block.split('\n').filter(l => l.startsWith(`${name}:`)).map(l => l.slice(name.length + 1).trimStart()).join('\n')
                    await onEvent({event: field('event') || 'message', data: field('data'), id: field('id')})
                }
            }
            log('the stream ended; reconnecting')
        } catch (error) {
            if (signal?.aborted) return
            log(`can't reach orrery (${error.message}); trying again in ${wait / 1000}s`)
        }
        await new Promise(resolve => {
            const timer = setTimeout(resolve, wait)
            signal?.addEventListener('abort', () => resolve(clearTimeout(timer)), {once: true})
        })
    }
}
