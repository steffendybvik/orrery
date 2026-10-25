// Tells useUnseen about every write this page makes to an issue or a doc, wherever in the app it's made,
// so the owner's own changes don't come back marked as news. Knows the owner too, as what they made starts seen.
export default defineNuxtPlugin(() => {
    const {wroteTo} = useUnseen()
    const write = $fetch.create({
        onRequest({request, options}) {
            if ((options.method ?? 'GET').toUpperCase() !== 'GET') wroteTo(typeof request === 'string' ? request : request.url)
        },
    })
    globalThis.$fetch = write as typeof $fetch
    useOwner().load().catch(() => {})
})
