import {withoutClosed, withoutNotes} from '#shared/patch'

// `GET /api/projects/:project` → the project with its board, and `rev`, the revision the events stream's patches build
// on; `?notes=0` leaves the issues' notes out (ORR-439), and `?closed=0` the closed issues with no open sub-issue (ORR-447).
export default defineEventHandler(async event => {
    const query = getQuery(event)
    const project = withRev(await useStore().project(param(event, 'project')))
    const lighter = query.notes === '0' ? withoutNotes(project) : project
    return query.closed === '0' ? withoutClosed(lighter) : lighter
})
