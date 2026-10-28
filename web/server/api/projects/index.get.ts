// `GET /api/projects` → every project with its counts; `?expand=board` adds each one's board, and `rev`, the revision
// the events stream's patches build on (see `/api/events?patch=1`).
export default defineEventHandler(async event => getQuery(event).expand === 'board'
    ? (await useStore().listBoards()).map(withRev)
    : await useStore().listProjects())
