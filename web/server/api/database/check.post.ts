// `POST /api/database/check` `{kind: "sqlite", path}` or `{kind: "postgres", url}` → what's in that database
// (`DatabaseCheck`): empty, an Orrery's own, the one Orrery runs on, or something else's. Nothing in it changes.
// The owner's, from localhost; 400 when it can't be reached or read.
export default defineEventHandler(async event => {
    await mayMove(event)
    return await checkDatabase(targetOf(await readBody(event)))
})
