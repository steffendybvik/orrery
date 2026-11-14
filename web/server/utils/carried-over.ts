// A session that just started an issue, and whether it carries another issue's context into it (ORR-968): what the
// route here, and the router for one the Rust API served (ORR-1130), add to the reply, as only this server knows the
// sessions.
import type {CarriedOver, IssueScope} from '#shared/roadmap'
import {useEventLog} from './events'
import {chatSession, sessionNow, startedIssue, untrustedSession} from './sessions'

type Started = IssueScope & {kind?: string}

/** Notes that `session` started `issue` (its edit sent a status, and it's started now). One that carried another issue's
 * context over is kept in the event log, so how often it happens shows, and gives back what it carried when orrery
 * started the session and clears it once it goes idle on it (`clearCarried`): the reply says so, for the session to end
 * its turn rather than carry on (`start_issue`). */
export function carriedInto(session: string, issue: Started): Pick<CarriedOver, 'from' | 'tokens'> | undefined {
    if (issue.kind !== 'started') return undefined
    const carry = startedIssue(session, {project: issue.project, id: issue.id, parent: issue.parent, milestone: issue.milestone, epic: issue.epic})
    if (!carry) return undefined
    const {session: on, carried: {from, to, tokens}} = carry
    useEventLog().note({level: 'info', kind: 'session.carried_over', project: issue.project, message: `${on.name} started ${to} with ${Math.round(tokens / 1000)}k tokens of ${from} in its context`, details: {session: on.id, from, to, tokens}})
    const now = sessionNow(session)
    if (now?.started && !now.started.chat && !now.started.untrusted && now.listening && !untrustedSession(session) && !chatSession(session)) return {from, tokens}
    return undefined
}
