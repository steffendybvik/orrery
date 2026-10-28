import {withoutNotes} from '#shared/patch'

// `GET /api/projects/:project` → the project with its board, and `rev`, the revision the events stream's patches build
// on; `?notes=0` leaves the issues' notes out (ORR-439).
export default defineEventHandler(async event => {
    const project = withRev(await useStore().project(param(event, 'project')))
    return getQuery(event).notes === '0' ? withoutNotes(project) : project
})
