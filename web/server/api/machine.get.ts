// `GET /api/machine` → what only this running server knows, none of it stored (ORR-954): which orrery it's run as
// (`environment`: `personal`, `work`, …), and where its data is and how big it is (`database`). The stored settings
// are `GET /api/settings`, which the Rust API can serve.
export default defineEventHandler(async () => {
    const store = useStore()
    const database = describeDatabase()
    return {
        environment: String(useRuntimeConfig().public.environment || 'personal'),
        database: {...database, ...await databaseSize(database, store.db)},
    }
})
