// `GET /api/sessions` → every Claude session Orrery knows, with its state and whether it listens.
export default defineEventHandler(async () => listSessions())
