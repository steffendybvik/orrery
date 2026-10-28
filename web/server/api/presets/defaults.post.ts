// `POST /api/presets/defaults` → the presets orrery ships that were removed, added back: the owner's only.
export default defineEventHandler(async event => useStore().restorePresets(await actorOf(event)))
