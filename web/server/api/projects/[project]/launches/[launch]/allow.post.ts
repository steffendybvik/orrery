// `POST /api/projects/:project/launches/:launch/allow` → the session: the owner allowing what a session orrery started
// is asking permission for. Its launcher answers "Yes" once, only while its pane still shows the prompt (ORR-489); 409
// when it isn't waiting at one, or no launcher is running for the project.
export default defineEventHandler(async event => {
    await authorize(event, 'sessions.allow')
    return allowLaunch(param(event, 'project'), param(event, 'launch'))
})
