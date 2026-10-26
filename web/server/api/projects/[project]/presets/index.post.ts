// `POST /api/projects/:project/presets` {name, text} → 201 the new preset, the project's own: the owner's only.
export default defineEventHandler(async event => {
    const preset = await useStore().createPreset(param(event, 'project'), await readBody(event), await actorOf(event))
    setResponseStatus(event, 201)
    return preset
})
