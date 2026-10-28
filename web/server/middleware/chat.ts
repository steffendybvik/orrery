// A write from the owner's chat session (its channel's tools send `Orrery-Chat: yes`, and `Orrery-Session`) is held to
// what a chat is for: making issues (its route leaves them unstarted and unassigned), commenting, and answering in its
// chat. Anything else it tries is refused, so a chat never takes up work or changes the roadmap otherwise.
const ISSUES = /^\/api\/projects\/[^/?]+\/issues\/?(\?|$)/
const COMMENTS = /^\/api\/projects\/[^/?]+\/issues\/[^/?]+\/comments\/?(\?|$)/
const REPLIES = /^\/api\/chats\/[^/?]+\/replies\/?(\?|$)/

export default defineEventHandler(event => {
    if (event.method === 'GET' || event.method === 'HEAD' || !chatWrite(event)) return
    if (event.method === 'POST' && [ISSUES, COMMENTS, REPLIES].some(route => route.test(event.path))) return
    throw forbidden("This session is the owner's chat: it answers (reply), makes issues (create_issue) and comments, and works on nothing")
})
