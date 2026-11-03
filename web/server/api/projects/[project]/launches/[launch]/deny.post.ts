// `POST /api/projects/:project/launches/:launch/deny` → the session: the owner denying what a session orrery started is
// asking permission for. Its launcher answers "No" once, only while its pane still shows the prompt (ORR-750); 409 when
// it isn't waiting at one, or no launcher is running for the project.
export default defineEventHandler(async event => {
    if (!await memberAsking(event)) await authorize(event, 'sessions.allow')
    return denyLaunch(param(event, 'project'), param(event, 'launch'))
})
