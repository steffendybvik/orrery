// `GET /api/projects/:project/context?kind=work|chat|untrusted` → what orrery puts into a session's context on the
// project, part by part with sizes (ORR-549); `?session=<id>` for a running one's, with its start context.
import type {ContextKind} from '#shared/context'
import {CONTEXT_KINDS} from '#shared/context'

export default defineEventHandler(async event => {
    const project = param(event, 'project')
    await useStore().project(project)
    const {kind, session} = getQuery(event)
    const base = getRequestURL(event).origin
    if (session) {
        const view = sessionContextView(String(session), base)
        if (!view) throw notFound(`No session ${session}`)
        return view
    }
    const asked = String(kind ?? 'work') as ContextKind
    if (!CONTEXT_KINDS.includes(asked)) throw badRequest(`kind is one of ${CONTEXT_KINDS.join(', ')}`)
    return contextView(asked, [project], base)
})
