// `POST /api/presets/:preset/reset` → the preset, back as orrery ships it: the owner's only; 409 for one it doesn't ship.
export default defineEventHandler(async event => useStore().resetPreset(Number(param(event, 'preset')), await actorOf(event)))
