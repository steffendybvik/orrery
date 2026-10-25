// `GET /api/statuses` → the issue statuses, in board order: `{id, name, kind, color, position}`.
export default defineEventHandler(async () => useStore().statuses())
