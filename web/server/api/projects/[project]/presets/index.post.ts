// `POST /api/projects/:project/presets` {name, text, icon?, color?} → 201 the new preset, the project's own.
export default defineEventHandler(async event => {
    const preset = await useStore().createPreset(param(event, 'project'), await readBody(event), await actorOf(event))
    setResponseStatus(event, 201)
    return preset
})
