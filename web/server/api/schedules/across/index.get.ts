// `GET /api/schedules/across` → the schedules across projects, oldest first.
export default defineEventHandler(async () => useScheduler().listAcross())
