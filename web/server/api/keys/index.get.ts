// `GET /api/keys` → this person's keys, or everyone's for the owner: never a key's secret, only what it's for and when it was used.
export default defineEventHandler(async event => {
    const {person, owner} = await keyHolderOf(event)
    return useStore().keys(owner ? undefined : person)
})
