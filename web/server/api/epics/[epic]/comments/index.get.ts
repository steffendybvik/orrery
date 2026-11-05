// `GET /api/epics/:epic/comments` → its comments, oldest first (ORR-977).
export default defineEventHandler(async event => useStore().listEpicComments(epicId(event)))
