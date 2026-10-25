// `POST /api/statuses` {name, kind, color?, id?, position?} → the new status: the owner's only. `kind` is
// what it means (backlog, todo, started, done, canceled); its id is the name as a slug unless given.
export default defineEventHandler(async event => {
    const status = useStore().createStatus(await readBody(event), actorOf(event))
    setResponseStatus(event, 201)
    return status
})
