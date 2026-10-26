// `POST /api/uploads` {data, name?} → the image's id, url and the Markdown that shows it. A body too big to hold
// the largest image (base64 makes it a third bigger) is refused before it's read.
const BODY_LIMIT = Math.ceil(UPLOAD_LIMIT * 4 / 3) + 64 * 1024

export default defineEventHandler(async event => {
    if (Number(getHeader(event, 'content-length') ?? 0) > BODY_LIMIT) {
        throw createError({statusCode: 413, statusMessage: 'Payload Too Large', message: `An image is ${UPLOAD_LIMIT / 1024 / 1024} MB at most`})
    }
    return created(event, await useStore().createUpload(await readBody(event), await actorOf(event)))
})
