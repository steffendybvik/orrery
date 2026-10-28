// `GET /api/sessions` → every Claude session orrery knows, with its state and whether it listens.
export default defineEventHandler(async () => listSessions())
