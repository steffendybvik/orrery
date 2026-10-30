// Tells useUnseen about every write this page makes to an issue or a doc, wherever in the app it's made,
// so the owner's own changes don't come back marked as news. Knows the owner too, as what they made starts seen.
export default defineNuxtPlugin(() => {
    const {wroteTo} = useUnseen()
    const write = $fetch.create({
        // A login that's run out or been ended (ORR-664) goes back to the door, rather than leaving a page that can't load.
        onResponseError({response}) {
            if (response.status === 401 && location.pathname !== '/login') location.assign('/login')
        },
        onRequest({request, options}) {
            if ((options.method ?? 'GET').toUpperCase() !== 'GET') wroteTo(typeof request === 'string' ? request : request.url)
        },
    })
    globalThis.$fetch = write as typeof $fetch
    if (!useAuth().loggedOut.value) useOwner().load().catch(() => {})
})
