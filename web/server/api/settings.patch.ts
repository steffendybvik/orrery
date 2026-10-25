// `PATCH /api/settings` {tint?} → the settings: the owner's only. `tint` is a named colour (blue, …), a
// `#rrggbb`, or null for none.
export default defineEventHandler(async event => useStore().updateSettings(await readBody(event), await actorOf(event)))
