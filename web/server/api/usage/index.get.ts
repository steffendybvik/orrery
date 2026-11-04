// `GET /api/usage` → {on, allowed, features: [{feature, label, last, days30, days90}]}: how often the owner used each
// counted feature, coldest first, for App settings' Usage (ORR-881). `on` is the owner's switch (`count_use`, off by
// default), `allowed` false when the server turns counting off (`ORRERY_USAGE=off`). The owner's alone.
export default defineEventHandler(async event => {
    const actor = await actorOf(event)
    if (!actor.owner) throw forbidden('How the features are used is the owner\'s to read')
    await flushUse()
    return {on: (await useStore().settings()).count_use, allowed: usageAllowed(), features: await featureUse()}
})
