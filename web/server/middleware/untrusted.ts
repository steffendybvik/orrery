// A write from an untrusted schedule's session (its channel's tools send `Orrery-Untrusted: yes`, and `Orrery-Session`;
// it has no other way to reach Orrery) is held to what that session is for, whether or not Orrery knows its launch
// (it may have restarted since): raising proposals (its new issue is made one, labelled
// `external`, by its route) and commenting on such proposals. Anything else it tries is refused, so what it read
// can't steer it into changing the roadmap, the docs or a secret's use.
const ISSUES = /^\/api\/projects\/[^/?]+\/issues\/?(\?|$)/
const COMMENTS = /^\/api\/projects\/([^/?]+)\/issues\/([^/?]+)\/comments\/?(\?|$)/

export default defineEventHandler(async event => {
    if (event.method === 'GET' || event.method === 'HEAD') return
    const session = getHeader(event, 'orrery-session')?.trim()
    if (getHeader(event, 'orrery-untrusted') !== 'yes' && !(session && untrustedSession(session))) return
    if (event.method === 'POST' && ISSUES.test(event.path)) return
    const comment = event.method === 'POST' ? COMMENTS.exec(event.path) : null
    if (comment?.[1] && comment[2]) {
        const issue = await useStore().issue(decoded(comment[1]), decoded(comment[2])).catch(() => null)
        if (issue?.proposal === 'pending' && issue.labels.includes(EXTERNAL)) return
    }
    throw forbidden('This session reads what others wrote (an untrusted schedule), so it only raises proposals (create_issue) and comments on them')
})
