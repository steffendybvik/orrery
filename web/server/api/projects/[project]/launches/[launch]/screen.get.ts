// `GET /api/projects/:project/launches/:launch/screen` → {screen, at?}: the owner viewing a session Orrery started, read
// only. Its launcher sends the screen (tmux's pane, as text) about once a second for as long as this is asked for;
// `screen` is null until the first comes in. 409 when no launcher is running for the project.
export default defineEventHandler(async event => {
    if (!(await actorOf(event)).owner) throw forbidden('Only the owner views a session Orrery started; send Orrery-Actor: <owner>')
    return viewLaunch(param(event, 'project'), param(event, 'launch'))
})
