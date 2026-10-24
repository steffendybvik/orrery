// `GET /api/owner` → {name}: the owner's name, which the page sends as `Orrery-Actor`.
export default defineEventHandler(() => ({name: String(useRuntimeConfig().owner)}))
