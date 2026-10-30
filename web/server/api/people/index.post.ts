// `POST /api/people` {name} → 201 the person, a member: the owner's only. Their id is the name in lowercase snake case. A second
// person turns login on, so it's refused (409) until the server has been claimed, unless ORRERY_AUTH=off.
export default defineEventHandler(async event => {
    await authorize(event, 'people.write')
    await needsWayInForPeople()
    const person = await useStore().addPerson(await readBody(event))
    setResponseStatus(event, 201)
    return person
})
