// `DELETE /api/projects/:project/members/:person` → 204: takes them off the board, as adding does. Its holder stays (400).
export default defineEventHandler(async event => {
    await useStore().removeMember(param(event, 'project'), param(event, 'person'), await actorOf(event))
    return deleted(event)
})
