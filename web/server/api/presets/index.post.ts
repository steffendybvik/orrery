// `POST /api/presets` {name, text, icon?, color?} → 201 the new preset, the Orrery's.
export default defineEventHandler(async event => {
    const preset = await useStore().createPreset(null, await readBody(event), await actorOf(event))
    setResponseStatus(event, 201)
    return preset
})
