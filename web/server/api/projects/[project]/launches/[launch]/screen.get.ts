// `GET /api/projects/:project/launches/:launch/screen` → {screen, at?}: the owner viewing a session orrery started, read
// only. Its launcher sends the screen (tmux's pane, as text) about once a second for as long as this is asked for;
// `screen` is null until the first comes in. 409 when no launcher is running for the project; 403 when the session is
// another person's, as a screen is its own person's only (ORR-964), the server's owner included.
import type {Who} from '../../../../../utils/auth'

export default defineEventHandler(async event => {
    await authorize(event, 'sessions.watch')
    // The checked credential's person: with login off there's only the one person, so nothing to hold apart.
    const who = event.context?.who as Who | undefined
    return viewLaunch(param(event, 'project'), param(event, 'launch'), Date.now(), who?.person)
})
