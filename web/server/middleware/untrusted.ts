// A write from an untrusted schedule's session (its channel's tools send `Orrery-Untrusted: yes`, and `Orrery-Session`;
// it has no other way to reach orrery) is held to the permissions table's untrusted column (`guard`, ORR-512), whether or
// not orrery knows its launch (it may have restarted since): raising proposals (its new issue is made one, labelled
// `external`, by its route) and commenting on such proposals (the cell's `externalProposal`). Anything else it tries is
// refused, so what it read can't steer it into changing the roadmap, the docs or a secret's use. Once orrery knows its
// session, it's held to the project it was started for too (ORR-1069), whatever its channel would let it name.
import {guard} from '../utils/guard'

/** The project a write under `/api/projects/:project/…` is to, as the path names it. */
const projectIn = (path: string) => /^\/api\/projects\/([^/?#]+)\//.exec(path)?.[1]

export default defineEventHandler(async event => {
    if (!untrustedWrite(event)) return
    await guard(event, 'untrusted', 'This session reads what others wrote (an untrusted schedule), so it only raises proposals (create_issue) and comments on them')
    if (event.method === 'GET' || event.method === 'HEAD') return
    const own = untrustedProject(sessionHeader(event))
    const named = projectIn(event.path)
    if (!own || !named) return
    const project = await useStore().projectId(decodeURIComponent(named)).catch(() => decodeURIComponent(named))
    if (project !== own) throw createError({statusCode: 403, statusMessage: 'Forbidden', message: `This session reads what others wrote (an untrusted schedule) for ${own}, so it only writes there`})
})
