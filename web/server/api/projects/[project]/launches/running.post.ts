// `POST /api/projects/:project/launches/running` {launches: [{id, tmux, stopsAt}]} → 204: the project's
// launcher, as it connects, saying which sessions it started are still running, so an Orrery that restarted
// counts them as started again, with their stop times and +30 min.
export default defineEventHandler(async event => {
    const project = param(event, 'project')
    await useStore().projectId(project)
    const body = await readBody(event)
    const launches = (body as {launches?: unknown})?.launches
    const ok = (l: unknown): l is {id: string, tmux: string, stopsAt: string} => {
        const {id, tmux, stopsAt} = (l ?? {}) as Record<string, unknown>
        return typeof id === 'string' && /^[0-9a-f]{12}$/.test(id) && typeof tmux === 'string' && /^[\w-]{1,120}$/.test(tmux)
            && typeof stopsAt === 'string' && !Number.isNaN(Date.parse(stopsAt))
    }
    if (!Array.isArray(launches) || !launches.every(ok)) throw badRequest('Send {launches: [{id, tmux, stopsAt}]}: a launch id, its tmux session and when it stops')
    reportRunning(project, launches.map(({id, tmux, stopsAt}) => ({id, tmux, stopsAt: new Date(stopsAt).toISOString()})))
    setResponseStatus(event, 204)
    return null
})
