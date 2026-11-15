// `POST /api/projects/:project/launches/:launch/stuck` {why} → 204: the launcher saying the session it started is stuck
// on a startup prompt it won't answer for the owner (ORR-1198), so orrery says why, in the event log and on a chat,
// rather than waiting on it.
export default defineEventHandler(async event => {
    const [project, launch] = [param(event, 'project'), param(event, 'launch')]
    launcherMayTell(event, launch)
    const {why} = checkInput(await readBody(event).catch(() => ({})) ?? {}, {why: {type: 'string', required: true}})
    launchStuck(project, launch, String(why).slice(0, 500))
    setResponseStatus(event, 204)
    return null
})
