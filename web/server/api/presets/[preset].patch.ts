// `PATCH /api/presets/:preset` {name?, text?} → the preset, the Orrery's or a project's: the owner's only.
export default defineEventHandler(async event => useStore().updatePreset(Number(param(event, 'preset')), await readBody(event), await actorOf(event)))
