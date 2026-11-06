import type {Effort, SessionContext} from '#shared/roadmap'
import {isEffort, isModel} from '#shared/roadmap'

// `POST /api/projects/:project/launches/running` {launches: [{id, tmux, stops_at?, context?, untrusted?, chat?, model?, effort?}]} → 204: the project's
// launcher, as it connects, saying which sessions it started are still running, so an orrery that restarted
// counts them as started again, with their stop times (none: until stopped), the context they were started with, and whether they're locked down or a chat, and the model and effort they were started on.
export default defineEventHandler(async event => {
    const project = param(event, 'project')
    await useStore().projectId(project)
    const body = await readBody(event)
    const launches = (body as {launches?: unknown})?.launches
    const ok = (l: unknown): l is {id: string, tmux: string, stops_at?: string, context?: SessionContext, untrusted?: boolean, chat?: boolean, model?: string, effort?: Effort} => {
        const {id, tmux, stops_at, context, untrusted, chat, model, effort} = (l ?? {}) as Record<string, unknown>
        return typeof id === 'string' && /^[0-9a-f]{12}$/.test(id) && typeof tmux === 'string' && /^[\w-]{1,120}$/.test(tmux)
            && (stops_at === undefined || (typeof stops_at === 'string' && !Number.isNaN(Date.parse(stops_at)))) && (context === undefined || context === null || isContext(context))
            && (untrusted === undefined || typeof untrusted === 'boolean') && (chat === undefined || typeof chat === 'boolean')
            && (model === undefined || isModel(model)) && (effort === undefined || isEffort(effort))
    }
    if (!Array.isArray(launches) || !launches.every(ok)) throw badRequest('Send {launches: [{id, tmux, stops_at?, context?}]}: a launch id, its tmux session, when it stops (none: until stopped) and its context')
    // A member's launcher reports only its own person's launches (ORR-963): the owner's it can't have started.
    const member = launcherMember(event)
    reportRunning(project, launches.filter(l => hearsLaunch(member, l.id)).map(({id, tmux, stops_at, context, untrusted, chat, model, effort}) => ({id, tmux, ...untrusted ? {untrusted} : {}, ...chat ? {chat} : {}, ...model ? {model} : {}, ...effort ? {effort} : {}, ...stops_at ? {stops_at: new Date(stops_at).toISOString()} : {}, ...context ? {context: {presets: context.presets, ...context.instructions ? {instructions: context.instructions} : {}, text: context.text}} : {}})))
    setResponseStatus(event, 204)
    return null
})

/** A context as a launcher keeps it: `{presets: [names], instructions?, text}`. */
function isContext(value: unknown): value is SessionContext {
    const {presets, instructions, text} = (value ?? {}) as Record<string, unknown>
    return Array.isArray(presets) && presets.every(p => typeof p === 'string') && (instructions === undefined || typeof instructions === 'string')
        && typeof text === 'string' && !!text
}
