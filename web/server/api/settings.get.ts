// `GET /api/settings` → this Orrery's own settings, e.g. `{id, environment, tint}`, and where its data is and how big
// it is (`database`).
export default defineEventHandler(async () => {
    const store = useStore()
    const database = describeDatabase()
    return {
        ...await store.settings(),
        environment: String(useRuntimeConfig().public.environment || 'personal'),
        database: {...database, ...await databaseSize(database, store.db)},
    }
})
