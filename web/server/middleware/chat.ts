// A write from the owner's chat session (its channel's tools send `Orrery-Chat: yes`, and `Orrery-Session`) is held to
// what a chat is for: making issues (its route leaves them unstarted and unassigned), commenting, answering in its
// chat, and messaging other sessions for the owner when they ask (as theirs, `chatOwner`). Anything else it tries is
// refused, so a chat never takes up work or changes the roadmap otherwise.
const ISSUES = /^\/api\/projects\/[^/?]+\/issues\/?(\?|$)/
const COMMENTS = /^\/api\/projects\/[^/?]+\/issues\/[^/?]+\/comments\/?(\?|$)/
const REPLIES = /^\/api\/chats\/[^/?]+\/replies\/?(\?|$)/
const MESSAGE_ALL = /^\/api\/sessions\/message\/?(\?|$)/
const MESSAGE_ONE = /^\/api\/projects\/[^/?]+\/sessions\/[^/?]+\/message\/?(\?|$)/

export default defineEventHandler(event => {
    if (event.method === 'GET' || event.method === 'HEAD' || !chatWrite(event)) return
    if (event.method === 'POST' && [ISSUES, COMMENTS, REPLIES, MESSAGE_ALL, MESSAGE_ONE].some(route => route.test(event.path))) return
    throw forbidden("This session is the owner's chat: it answers (reply), makes issues (create_issue) and comments, messages sessions when the owner asks, and works on nothing")
})
