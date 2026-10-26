import type {SessionContext} from '#shared/roadmap'

// `POST /api/projects/:project/launches/running` {launches: [{id, tmux, stops_at, context?}]} → 204: the project's
// launcher, as it connects, saying which sessions it started are still running, so an Orrery that restarted
// counts them as started again, with their stop times, +30 min and the context they were started with.
export default defineEventHandler(async event => {
    const project = param(event, 'project')
    await useStore().projectId(project)
    const body = await readBody(event)
    const launches = (body as {launches?: unknown})?.launches
    const ok = (l: unknown): l is {id: string, tmux: string, stops_at: string, context?: SessionContext} => {
        const {id, tmux, stops_at, context} = (l ?? {}) as Record<string, unknown>
        return typeof id === 'string' && /^[0-9a-f]{12}$/.test(id) && typeof tmux === 'string' && /^[\w-]{1,120}$/.test(tmux)
            && typeof stops_at === 'string' && !Number.isNaN(Date.parse(stops_at)) && (context === undefined || context === null || isContext(context))
    }
    if (!Array.isArray(launches) || !launches.every(ok)) throw badRequest('Send {launches: [{id, tmux, stops_at, context?}]}: a launch id, its tmux session, when it stops and its context')
    reportRunning(project, launches.map(({id, tmux, stops_at, context}) => ({id, tmux, stops_at: new Date(stops_at).toISOString(), ...context ? {context: {presets: context.presets, ...context.instructions ? {instructions: context.instructions} : {}, text: context.text}} : {}})))
    setResponseStatus(event, 204)
    return null
})

/** A context as a launcher keeps it: `{presets: [names], instructions?, text}`. */
function isContext(value: unknown): value is SessionContext {
    const {presets, instructions, text} = (value ?? {}) as Record<string, unknown>
    return Array.isArray(presets) && presets.every(p => typeof p === 'string') && (instructions === undefined || typeof instructions === 'string')
        && typeof text === 'string' && !!text
}
