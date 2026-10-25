// `GET /api/settings` → this Orrery's own settings, e.g. `{tint}`.
export default defineEventHandler(async () => useStore().settings())
