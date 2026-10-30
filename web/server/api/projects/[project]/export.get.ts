// `GET /api/projects/:project/export` → the board as one file (board-export.ts): a snapshot, with no secrets, that leaves
// the board as it is. Named for the project and the day, so a browser saves it.
export default defineEventHandler(async event => {
    const project = param(event, 'project')
    await needsBoard(event, project)
    await useStore().project(project)
    const board = await exportBoard(useDatabase(), project)
    setHeader(event, 'Content-Disposition', `attachment; filename="${project}-${board.exported_at.slice(0, 10)}.orrery.json"`)
    return board
})
