// `POST /api/projects/:project/signals/:signal/delivered?session=&pid=&name=` → the signal: a session's channel
// saying the signal reached it, which also sets the session working.
export default defineEventHandler(event => {
    const query = getQuery(event)
    // A signal starts the session working, without a prompt for its hooks to see.
    if (typeof query.session === 'string' && query.session) report({id: query.session, project: param(event, 'project'), event: 'working'})
    const name = sessionName(typeof query.session === 'string' ? query.session : undefined)
        ?? (typeof query.name === 'string' && query.name ? query.name : 'a session')
    return useStore().delivered(param(event, 'project'), Number(param(event, 'signal')), name)
})
