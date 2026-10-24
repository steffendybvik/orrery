// `POST /api/projects/:project/docs` {title, body?, id?, position?} → the new doc. `body` is Markdown.
export default defineEventHandler(async event => created(event, useStore().createDoc(param(event, 'project'), await readBody(event), actorOf(event))))
