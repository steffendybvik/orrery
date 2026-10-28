import type {SessionContext} from '#shared/roadmap'

// `POST /api/projects/:project/launches/running` {launches: [{id, tmux, stops_at?, context?, untrusted?, chat?}]} → 204: the project's
// launcher, as it connects, saying which sessions it started are still running, so an Orrery that restarted
// counts them as started again, with their stop times (none: until stopped), the context they were started with, and whether they're locked down or a chat.
export default defineEventHandler(async event => {
    const project = param(event, 'project')
    await useStore().projectId(project)
    const body = await readBody(event)
    const launches = (body as {launches?: unknown})?.launches
    const ok = (l: unknown): l is {id: string, tmux: string, stops_at?: string, context?: SessionContext, untrusted?: boolean, chat?: boolean} => {
        const {id, tmux, stops_at, context, untrusted, chat} = (l ?? {}) as Record<string, unknown>
        return typeof id === 'string' && /^[0-9a-f]{12}$/.test(id) && typeof tmux === 'string' && /^[\w-]{1,120}$/.test(tmux)
            && (stops_at === undefined || (typeof stops_at === 'string' && !Number.isNaN(Date.parse(stops_at)))) && (context === undefined || context === null || isContext(context))
            && (untrusted === undefined || typeof untrusted === 'boolean') && (chat === undefined || typeof chat === 'boolean')
    }
    if (!Array.isArray(launches) || !launches.every(ok)) throw badRequest('Send {launches: [{id, tmux, stops_at?, context?}]}: a launch id, its tmux session, when it stops (none: until stopped) and its context')
    reportRunning(project, launches.map(({id, tmux, stops_at, context, untrusted, chat}) => ({id, tmux, ...untrusted ? {untrusted} : {}, ...chat ? {chat} : {}, ...stops_at ? {stops_at: new Date(stops_at).toISOString()} : {}, ...context ? {context: {presets: context.presets, ...context.instructions ? {instructions: context.instructions} : {}, text: context.text}} : {}})))
    setResponseStatus(event, 204)
    return null
})

/** A context as a launcher keeps it: `{presets: [names], instructions?, text}`. */
function isContext(value: unknown): value is SessionContext {
    const {presets, instructions, text} = (value ?? {}) as Record<string, unknown>
    return Array.isArray(presets) && presets.every(p => typeof p === 'string') && (instructions === undefined || typeof instructions === 'string')
        && typeof text === 'string' && !!text
}
