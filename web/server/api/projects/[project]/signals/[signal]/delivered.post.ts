// `POST /api/projects/:project/signals/:signal/delivered?session=&pid=&name=` → the signal: a session's channel
// saying the signal reached it, which also sets the session working, if its hooks can say when that ends.
export default defineEventHandler(async event => {
    const query = getQuery(event)
    if (typeof query.session === 'string' && query.session) signalReached(query.session, param(event, 'project'))
    const name = sessionName(typeof query.session === 'string' ? query.session : undefined)
        ?? (typeof query.name === 'string' && query.name ? query.name : 'a session')
    return await useStore().delivered(param(event, 'project'), Number(param(event, 'signal')), name)
})
