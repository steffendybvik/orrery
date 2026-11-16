// `POST /api/orrery-moves` {direction, url, key, name, from?, color?, add?, dryRun?, enableSchedules?}: moves a whole workspace
// of this orrery to another (`send`), or one of another's here (`bring`), as `pnpm orrery:import` does (ORR-1249). The
// owner's alone, from their page. A dry run answers at once, 200 {report, summary}, having written nothing; a move answers
// 202 {id} and runs on, followed at `GET /api/orrery-moves/:id`.
export default defineEventHandler(async event => {
    await authorize(event, 'orrery.move')
    await moveByOwnersPage(event)
    const ask = moveAskOf(await readBody(event))
    // On a send, the workspace that goes is the one the page is in.
    if (ask.direction === 'send') ask.from = getHeader(event, 'orrery-workspace')?.trim() || ask.from
    const {source, target} = await moveSides(event, ask)
    const options = {source, target, name: ask.name, color: ask.color, fromWorkspace: ask.from, add: ask.add, enableSchedules: ask.enableSchedules}
    if (ask.dryRun) {
        const report = await importWholeOrrery({...options, dryRun: true}).catch((error: Error) => {
            throw createError({statusCode: 400, statusMessage: 'Bad Request', message: error.message})
        })
        return {report, summary: moveSummary(report)}
    }
    const who = (await actorOf(event)).name
    const log = useEventLog()
    const run = startMove({direction: ask.direction, remote: ask.url, workspace: ask.name}, async hooks => {
        try {
            const report = await importWholeOrrery({...options, ...hooks})
            log.note({level: 'info', kind: 'orrery.moved', message: `${who} ${ask.direction === 'send' ? `sent workspace ${ask.from} to ${ask.url}` : `brought ${ask.url}'s workspace ${ask.from} in`} as "${ask.name}"`, details: {direction: ask.direction, remote: ask.url, by: who}})
            return report
        } catch (error) {
            log.note({level: 'error', kind: 'orrery.move_failed', message: `Moving ${ask.direction === 'send' ? `to ${ask.url}` : `from ${ask.url}`} stopped: ${(error as Error).message}`, details: {direction: ask.direction, remote: ask.url, by: who}})
            throw error
        }
    })
    setResponseStatus(event, 202)
    return {id: run.id}
})
