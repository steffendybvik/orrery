// `POST /api/database/move` `{kind, path | url, how: "copy" | "use"}`: orrery runs on that database from now on,
// and from the next start. `copy` takes everything into an empty one, `use` runs on an orrery's own as it is. → the
// check it passed, what was copied (rows per table), and `database` as `GET /api/settings` has it. The owner's,
// from localhost; 409 when the database doesn't suit how (see server/utils/move.ts).
export default defineEventHandler(async event => {
    await mayMove(event)
    const body = await readBody<{how?: unknown}>(event)
    if (body?.how !== 'copy' && body?.how !== 'use') throw badRequest('"how" is "copy" (into an empty database) or "use" (an orrery\'s own, as it is)')
    const before = describeDatabase()
    const moved = await moveDatabase(targetOf(body), body.how, rebindDatabase)
    const database = describeDatabase()
    // Copied into an empty one: orrery made it its own first (a swap to an orrery's own is the move alone).
    if (moved.copied) {
        const rows = Object.values(moved.copied).reduce((sum, n) => sum + n, 0)
        useEventLog().note({level: 'info', kind: 'database.created', message: `Made an orrery database at ${database.where} and copied ${rows} row${rows === 1 ? '' : 's'} into it`,
            details: {kind: database.kind, copied: moved.copied}})
    }
    useEventLog().note({level: 'info', kind: 'database.moved', message: `Moved the database from ${before.where} to ${database.where}`,
        details: {from: before.kind, to: database.kind, how: body.how, ...moved.copied ? {copied: moved.copied} : {}}})
    return {...moved, database: {...database, ...await databaseSize(database, useDatabase())}}
})
