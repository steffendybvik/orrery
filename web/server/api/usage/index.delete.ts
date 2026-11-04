// `DELETE /api/usage` → 204: forgets every feature count (ORR-881), as turning counting off offers to. The owner's alone.
export default defineEventHandler(async event => {
    ownerOnly(await actorOf(event), 'settings.write')
    await forgetUse()
    setResponseStatus(event, 204)
    return null
})
