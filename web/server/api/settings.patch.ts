// `PATCH /api/settings` {tint?} → the settings: the owner's only. `tint` is a named colour (blue, …), a
// `#rrggbb`, or null for none. The event log says which were changed, and by whom, never to what.
export default defineEventHandler(async event => {
    const body = await readBody(event)
    const actor = await actorOf(event)
    const settings = await useStore().updateSettings(body, actor)
    const keys = Object.entries(isObject(body) ? body : {}).filter(([, value]) => value !== undefined).map(([key]) => key).sort()
    if (keys.length) useEventLog().note({level: 'info', kind: 'settings.changed', message: `${actor.name} changed the settings: ${keys.join(', ')}`, details: {by: actor.name, keys}})
    return settings
})
