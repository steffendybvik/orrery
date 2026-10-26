// `POST /api/projects/:project/launches/:launch/watch` → the session: the owner watching a session Orrery started. Its
// launcher opens a terminal on its machine attached to it, in the app the settings name (`terminal`); 409 when no
// launcher is running for the project.
export default defineEventHandler(async event => {
    if (!(await actorOf(event)).owner) throw forbidden('Only the owner watches a session Orrery started; send Orrery-Actor: <owner>')
    const {terminal} = await useStore().settings()
    return watchLaunch(param(event, 'project'), param(event, 'launch'), terminal)
})
