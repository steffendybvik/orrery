// `PATCH /api/people/:person` {name} → the person, renamed: the owner's only. Their id stays.
export default defineEventHandler(async event => {
    await authorize(event, 'people.write')
    return useStore().renamePerson(param(event, 'person'), await readBody(event))
})
