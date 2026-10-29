// `POST /api/projects/:project/launches/:launch/extend` {minutes} → the session, with its new `started.stops_at`:
// the owner giving a session orrery started longer, from when it would have stopped.
export default defineEventHandler(async event => {
    await authorize(event, 'sessions.start')
    const {minutes} = checkInput(await readBody(event).catch(() => ({})) ?? {}, {minutes: {type: 'number', required: true}})
    if (!Number.isInteger(minutes) || Number(minutes) < 1 || Number(minutes) > 24 * 60) throw badRequest(`"minutes" should be a whole number from 1 to 1440, not ${minutes}`)
    return extendLaunchBy(param(event, 'project'), param(event, 'launch'), Number(minutes))
})
