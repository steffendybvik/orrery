// `DELETE /api/presets/:preset` → 204; one the owner made is theirs to remove. Sessions already started with it keep its text.
export default defineEventHandler(async event => {
    await useStore().deletePreset(Number(param(event, 'preset')), await actorOf(event))
    return deleted(event)
})
