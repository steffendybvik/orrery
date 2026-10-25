// `POST /api/uploads` {data, name?} → the image's id, url and the Markdown that shows it.
export default defineEventHandler(async event => created(event, await useStore().createUpload(await readBody(event), await actorOf(event))))
