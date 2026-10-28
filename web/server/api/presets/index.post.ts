// `POST /api/presets` {name, text} → 201 the new preset, the orrery's: the owner's only.
export default defineEventHandler(async event => {
    const preset = await useStore().createPreset(null, await readBody(event), await actorOf(event))
    setResponseStatus(event, 201)
    return preset
})
