// `GET /channel/<file>` → what a machine connected to this orrery runs (ORR-435, channel/bootstrap.mjs): the bootstrap, the
// bundled channel, hook and launcher, and `manifest.json` saying which orrery this is and what it serves.
export default defineEventHandler(async event => {
    const file = param(event, 'file')
    const assets = useStorage('assets:channel')
    if (file === 'manifest.json') {
        const manifest = await assets.getItem<Record<string, unknown>>(file)
        if (!manifest) throw notFound('This orrery has no channel bundle')
        setResponseHeader(event, 'Cache-Control', 'no-store')
        return {...manifest, id: (await useStore().settings()).id}
    }
    const body = /^[\w-]+\.mjs$/.test(file) ? await assets.getItemRaw<Buffer | string>(file) : null
    if (!body) throw notFound(`No ${file}`)
    setResponseHeader(event, 'Content-Type', 'text/javascript; charset=utf-8')
    setResponseHeader(event, 'Cache-Control', 'no-store')
    return Buffer.from(body as Buffer)
})
