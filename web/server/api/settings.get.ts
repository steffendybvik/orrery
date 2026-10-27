// `GET /api/settings` → this Orrery's own settings, e.g. `{id, environment, tint}`, and where its data is (`database`).
export default defineEventHandler(async () => ({
    ...await useStore().settings(),
    environment: String(useRuntimeConfig().public.environment || 'personal'),
    database: describeDatabase(),
}))
