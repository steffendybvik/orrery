// `DELETE /api/keys/:key` → 204: revokes it, at once. A person's own, or anyone's for the owner.
export default defineEventHandler(async event => {
    const {person, owner} = await keyHolderOf(event)
    await useStore().revokeKey(param(event, 'key'), owner ? undefined : person)
    setResponseStatus(event, 204)
    return null
})
