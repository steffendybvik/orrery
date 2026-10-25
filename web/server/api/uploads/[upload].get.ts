// `GET /api/uploads/:upload` → the image. It never changes, so the browser keeps it; and it's only ever
// an image, never a page that could run something.
export default defineEventHandler(async event => {
    const {type, data} = await useStore().upload(param(event, 'upload'))
    setResponseHeaders(event, {
        'Content-Type': type,
        'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
    })
    return data
})
