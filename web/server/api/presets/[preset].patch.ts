// `PATCH /api/presets/:preset` {name?, text?} → the preset, the orrery's or a project's: the owner's only.
export default defineEventHandler(async event => useStore().updatePreset(await presetId(event), await readBody(event), await actorOf(event)))
