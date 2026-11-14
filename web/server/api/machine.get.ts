// `GET /api/machine` → what only this running server knows, none of it stored (ORR-954): which orrery it's run as
// (`environment`: `personal`, `work`, …), and where its data is and how big it is (`database`). The stored settings
// are `GET /api/settings`, which the Rust API can serve.
// Where the data is is the installation's: a member who isn't the owner gets the name alone (ORR-1195).
export default defineEventHandler(async event => {
    const environment = String(useRuntimeConfig().public.environment || 'personal')
    const who = event.context.who as Who | undefined
    if (who && !who.owner) return {environment}
    const database = describeDatabase()
    return {environment, database: {...database, ...await sizeOfDatabase(database)}}
})
