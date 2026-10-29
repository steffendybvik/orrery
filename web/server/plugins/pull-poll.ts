// Polls the projects' pull requests on GitHub in the background (utils/pull-poll.ts): a few seconds after start, then
// each repo when it's due (every minute with a GITHUB_TOKEN secret, every ten without), checked every 15 seconds.
export default defineNitroPlugin(nitro => {
    const tick = () => usePullPoll().tick().catch(error => console.error('[orrery] polling pull requests:', error))
    const first = setTimeout(tick, 5000)
    const timer = setInterval(tick, 15_000)
    nitro.hooks.hook('close', () => {
        clearTimeout(first)
        clearInterval(timer)
    })
})
