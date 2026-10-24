// `GET /api/projects` → every project with its counts; `?expand=board` adds each one's board.
export default defineEventHandler(event => getQuery(event).expand === 'board' ? useStore().listBoards() : useStore().listProjects())
