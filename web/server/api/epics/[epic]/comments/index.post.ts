// `POST /api/epics/:epic/comments` {body} → the new comment (ORR-977): words on the epic's page, which ask nothing and
// wake no session.
export default defineEventHandler(async event => created(event, await useStore().createEpicComment(await epicId(event), await readBody(event), await actorOf(event))))
