// A write from the owner's chat session (its channel's tools send `Orrery-Chat: yes`, and `Orrery-Session`) is held to
// the permissions table's chat column (`guard`, ORR-512): making issues (its route leaves them unstarted and unassigned),
// changing one issue's words and place (its route refuses the rest, `asChatEdit`), commenting, answering and asking in its
// own chat. What it asks for (messaging sessions, a setting, a schedule, a release, a chunk, a move) is sent or saved only
// by the owner's Send or Allow, a route refused here. Anything else it tries is refused, so a chat never takes up work,
// changes the roadmap otherwise or speaks to another session on its own say.
import {guard} from '../utils/guard'

export default defineEventHandler(async event => {
    if (!chatWrite(event)) return
    await guard(event, 'chat', "This session is the owner's chat: it answers (reply), makes and changes issues (create_issue, edit_issue) and comments, asks the owner before messaging sessions or changing settings, schedules, releases, chunks or an issue's status, and works on nothing")
})
