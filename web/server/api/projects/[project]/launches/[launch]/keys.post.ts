// `POST /api/projects/:project/launches/:launch/keys` {text?, keys?} → {text, keys}: the owner typing into a session
// orrery started, from under its live screen (ORR-1152), for a phone, where its terminal can't be attached. Its launcher
// types `text` as it is, then presses each of `keys` (Enter, Escape, Tab, Up, Down, Left, Right, Backspace, Ctrl-C) into
// its tmux pane. 400 for anything else; 403 when the session is another person's, as its screen is its own person's
// only (ORR-964); 409 when no launcher is running for the project. Each is in the event log, without its text.
import type {Who} from '../../../../../utils/auth'

export default defineEventHandler(async event => {
    if (!await memberAsking(event)) await authorize(event, 'sessions.type')
    const who = event.context?.who as Who | undefined
    const body = await readBody(event).catch(() => null)
    return typeIntoLaunch(param(event, 'project'), param(event, 'launch'), body, who?.person)
})
