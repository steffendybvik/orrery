// `POST /api/projects/:project/launches/running` {launches: [{id, tmux, stops_at}]} → 204: the project's
// launcher, as it connects, saying which sessions it started are still running, so an Orrery that restarted
// counts them as started again, with their stop times and +30 min.
export default defineEventHandler(async event => {
    const project = param(event, 'project')
    await useStore().projectId(project)
    const body = await readBody(event)
    const launches = (body as {launches?: unknown})?.launches
    const ok = (l: unknown): l is {id: string, tmux: string, stops_at: string} => {
        const {id, tmux, stops_at} = (l ?? {}) as Record<string, unknown>
        return typeof id === 'string' && /^[0-9a-f]{12}$/.test(id) && typeof tmux === 'string' && /^[\w-]{1,120}$/.test(tmux)
            && typeof stops_at === 'string' && !Number.isNaN(Date.parse(stops_at))
    }
    if (!Array.isArray(launches) || !launches.every(ok)) throw badRequest('Send {launches: [{id, tmux, stops_at}]}: a launch id, its tmux session and when it stops')
    reportRunning(project, launches.map(({id, tmux, stops_at}) => ({id, tmux, stops_at: new Date(stops_at).toISOString()})))
    setResponseStatus(event, 204)
    return null
})
