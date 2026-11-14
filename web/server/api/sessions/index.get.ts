// `GET /api/sessions` → every Claude session orrery knows, with its state and whether it listens; a member who isn't the
// owner gets those on the projects they can see (ORR-1195).
export default defineEventHandler(async event => {
    const sees = await memberSees(event)
    return sees ? listSessions().filter(s => sees.has(s.project)) : listSessions()
})
