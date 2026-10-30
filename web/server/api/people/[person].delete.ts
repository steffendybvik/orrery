// `DELETE /api/people/:person` → 204: the owner's only. Their name stays on history, their open issues go back to
// unassigned, and their sessions can no longer claim.
export default defineEventHandler(async event => {
    const actor = await authorize(event, 'people.write')
    await useStore().removePerson(param(event, 'person'), actor)
    return deleted(event)
})
