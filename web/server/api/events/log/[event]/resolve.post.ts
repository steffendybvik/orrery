// `POST /api/events/log/:event/resolve` → the event, marked dealt with: the next one like it starts a row of its own.
// One an agent resolves keeps its name (`resolved_by`), and the bell still shows it until the owner looks (ORR-420).
export default defineEventHandler(async event => {
    const id = Number(param(event, 'event'))
    if (!Number.isInteger(id)) throw notFound(`No event ${param(event, 'event')}`)
    return useEventLog().resolve(id, await actorOf(event))
})
