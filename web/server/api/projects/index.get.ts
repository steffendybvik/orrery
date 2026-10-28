import {withoutClosed, withoutNotes} from '#shared/patch'

// `GET /api/projects` → every project with its counts; `?expand=board` adds each one's board, and `rev`, the revision
// the events stream's patches build on (see `/api/events?patch=1`); `&notes=0` leaves the issues' notes out (ORR-439), and
// `&closed=0` the closed issues with no open sub-issue (ORR-447), but for the projects in `&whole=` (comma-separated ids):
// the page's own, read whole in the same call.
export default defineEventHandler(async event => {
    const query = getQuery(event)
    if (query.expand !== 'board') return await useStore().listProjects()
    const boards = (await useStore().listBoards()).map(withRev)
    const whole = new Set(typeof query.whole === 'string' ? query.whole.split(',') : [])
    return boards.map(board => {
        const lighter = query.notes === '0' ? withoutNotes(board) : board
        return query.closed === '0' && !whole.has(board.id) ? withoutClosed(lighter) : lighter
    })
})
