// A write from the owner's chat session (its channel's tools send `Orrery-Chat: yes`, and `Orrery-Session`) is held to
// what a chat is for: making issues (its route leaves them unstarted and unassigned), changing what one says and where it
// sits when the owner asks (its route refuses status, assignee and the rest, `asChatEdit`), commenting, answering in its
// chat, and asking the owner to message sessions or change a setting, a schedule, a release or a chunk (`ask`; only the owner's
// Send or Allow, a route refused here, sends or saves it). Anything else it tries is refused, so a chat never takes up work,
// changes the roadmap otherwise or speaks to another session on its own say.
const ISSUES = /^\/api\/projects\/[^/?]+\/issues\/?(\?|$)/
const ISSUE = /^\/api\/projects\/[^/?]+\/issues\/[^/?]+\/?(\?|$)/
const COMMENTS = /^\/api\/projects\/[^/?]+\/issues\/[^/?]+\/comments\/?(\?|$)/
const REPLIES = /^\/api\/chats\/[^/?]+\/replies\/?(\?|$)/
const REQUESTS = /^\/api\/chats\/[^/?]+\/requests\/?(\?|$)/

export default defineEventHandler(event => {
    if (event.method === 'GET' || event.method === 'HEAD' || !chatWrite(event)) return
    if (event.method === 'POST' && [ISSUES, COMMENTS, REPLIES, REQUESTS].some(route => route.test(event.path))) return
    if (event.method === 'PATCH' && ISSUE.test(event.path)) return
    throw forbidden("This session is the owner's chat: it answers (reply), makes and changes issues (create_issue, edit_issue) and comments, asks the owner before messaging sessions or changing settings, schedules, releases or chunks, and works on nothing")
})
