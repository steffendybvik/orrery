// `POST /api/projects/:project/docs` {title, body?, id?, position?, section?} → the new doc. `body` is Markdown.
export default defineEventHandler(async event => created(event, await useStore().createDoc(param(event, 'project'), await readBody(event), await actorOf(event))))
