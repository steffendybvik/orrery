// `GET /api/orrery-moves/:id`: how a move started from App settings is getting on (ORR-1249): `{state, progress, lines,
// summary?, report?, error?}`. The owner's alone. A 404 once it's forgotten, an hour after it ended, or when the server
// restarted while it ran.
export default defineEventHandler(async event => {
    await moveByOwnersPage(event)
    const run = moveRun(getRouterParam(event, 'id') ?? '')
    if (!run) throw createError({statusCode: 404, statusMessage: 'Not Found', message: 'No such move here: it ended over an hour ago, or orrery restarted while it ran. Check the other orrery, and run it again with "Add to it" to bring what didn\'t arrive.'})
    return run
})
