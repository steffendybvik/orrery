import {withoutNotes} from '#shared/patch'

// `GET /api/projects` → every project with its counts; `?expand=board` adds each one's board, and `rev`, the revision
// the events stream's patches build on (see `/api/events?patch=1`); `&notes=0` leaves the issues' notes out (ORR-439).
export default defineEventHandler(async event => {
    const query = getQuery(event)
    if (query.expand !== 'board') return await useStore().listProjects()
    const boards = (await useStore().listBoards()).map(withRev)
    return query.notes === '0' ? boards.map(withoutNotes) : boards
})
