// Fail closed (ORR-653): on an orrery with more than one person, a session that names nobody, or somebody unknown, can
// read and comment but can't change an issue, singly or in bulk. The store holds the rest (`railsFor`, ORR-655).
const CHANGES = /^\/api\/projects\/[^/]+\/issues(\/[^/]+)?$/

export default defineEventHandler(async event => {
    if (event.method !== 'PATCH' || !CHANGES.test(getRequestURL(event).pathname)) return
    await needsPerson(event)
})
