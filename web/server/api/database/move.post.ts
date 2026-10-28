// `POST /api/database/move` `{kind, path | url, how: "copy" | "use"}`: Orrery runs on that database from now on,
// and from the next start. `copy` takes everything into an empty one, `use` runs on an Orrery's own as it is. → the
// check it passed, what was copied (rows per table), and `database` as `GET /api/settings` has it. The owner's,
// from localhost; 409 when the database doesn't suit how (see server/utils/move.ts).
export default defineEventHandler(async event => {
    await mayMove(event)
    const body = await readBody<{how?: unknown}>(event)
    if (body?.how !== 'copy' && body?.how !== 'use') throw badRequest('"how" is "copy" (into an empty database) or "use" (an Orrery\'s own, as it is)')
    const before = describeDatabase()
    const moved = await moveDatabase(targetOf(body), body.how, rebindDatabase)
    const database = describeDatabase()
    useEventLog().note({level: 'info', kind: 'database.moved', message: `Moved the database from ${before.where} to ${database.where}`,
        details: {from: before.kind, to: database.kind, how: body.how, ...moved.copied ? {copied: moved.copied} : {}}})
    return {...moved, database: {...database, ...await databaseSize(database, useDatabase())}}
})
