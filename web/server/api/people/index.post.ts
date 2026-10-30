// `POST /api/people` {name} → 201 the person, a member: the owner's only. Their id is the name in lowercase snake case.
export default defineEventHandler(async event => {
    await authorize(event, 'people.write')
    const person = await useStore().addPerson(await readBody(event))
    setResponseStatus(event, 201)
    return person
})
