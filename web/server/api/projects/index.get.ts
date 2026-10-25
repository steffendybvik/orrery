// `GET /api/projects` → every project with its counts; `?expand=board` adds each one's board.
export default defineEventHandler(async event => getQuery(event).expand === 'board' ? await useStore().listBoards() : await useStore().listProjects())
