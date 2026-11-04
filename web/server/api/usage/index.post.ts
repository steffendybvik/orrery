// `POST /api/usage` {feature} → 204: one use of a feature (ORR-881), a page opened or a tool called, counted only when
// it's the owner's own use (their page, their sessions), and only while counting is on. Anyone else's is ignored, with
// the same 204, so it says nothing of whether counting is on. `feature` is a listed one, `page:<route>` or `tool:<name>`.
export default defineEventHandler(async event => {
    const who = event.context?.who as {owner: boolean} | undefined
    const body = await readBody(event).catch(() => null) as {feature?: unknown} | null
    if ((!who || who.owner) && typeof body?.feature === 'string') countUse(body.feature)
    setResponseStatus(event, 204)
    return null
})
