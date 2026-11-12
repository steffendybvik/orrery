// `POST /api/projects/:project/launches/:launch/watch` → the session: the owner watching a session orrery started. Its
// launcher opens a terminal on its machine attached to it, in the app the settings name (`terminal`); 409 when no
// launcher is running for the project.
import type {Settings} from '#shared/roadmap'
import {countOwnUse} from '../../../../../utils/usage'

export default defineEventHandler(async event => {
    countOwnUse(event, 'watch-session')
    if (!await memberAsking(event)) await authorize(event, 'sessions.watch')
    const {terminal} = (await readFromApi<Settings>('/api/settings')) ?? await useStore().settings()
    return watchLaunch(param(event, 'project'), param(event, 'launch'), terminal)
})
