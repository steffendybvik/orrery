// `POST /api/projects/:project/launches/:launch/watch` → the session: the owner watching a session orrery started. Its
// launcher opens a terminal on its machine attached to it, in the app the settings name (`terminal`); 409 when no
// launcher is running for the project.
export default defineEventHandler(async event => {
    await authorize(event, 'sessions.watch')
    const {terminal} = await useStore().settings()
    return watchLaunch(param(event, 'project'), param(event, 'launch'), terminal)
})
