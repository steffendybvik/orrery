// A session working an issue hears when what the issue sits under changes (ORR-984): the issue moved into or out of an
// epic or a milestone (`issue.epic`, `issue.milestone`, a deleted one's issues included), or that epic or milestone's
// title, notes or summary changed (`epic.changed`, `milestone.changed`). Otherwise it keeps its old picture until it
// reads the issue again.
//
// It's a `message` aimed at the session on each started issue affected, the one that last worked it while it listens,
// and nobody else: none goes to the pool, so none starts a session, and a session on nothing affected hears nothing.
// One message per session for a burst (a milestone deleted with its issues, a bulk move), said once the burst is over.
// Only the owner's changes are told, and a member's to their own sessions alone (ORR-658), as the guards say: an
// agent's, orrery's own, a schedule run's (`cause`) and an untrusted session's tell nobody.
import type {OrreryEvent} from '#shared/happenings'
import type {IssueRecord} from '../store/schema'

/** How long after a change the sessions are told, so a burst is one message each. */
export const SCOPE_AFTER = 1500

type Change = {type: string, subject: string, from?: string, to?: string, member?: string}

/** What changed since the last telling, by project. */
const heard = new Map<string, Change[]>()
let timer: ReturnType<typeof setTimeout> | undefined

const TYPES = new Set(['issue.epic', 'issue.milestone', 'epic.changed', 'milestone.changed'])

/** What the store said happened: kept for the next telling when it's a scope change by the owner or a member. */
export function heardScope({event, cause}: {event: OrreryEvent, cause?: unknown}) {
    if (cause || event.untrusted || !event.project || !event.subject || !TYPES.has(event.type)) return
    if (!event.by?.owner && !event.by?.person) return
    const changes = heard.get(event.project) ?? []
    changes.push({type: event.type, subject: event.subject, ...event.from ? {from: event.from} : {}, ...event.to ? {to: event.to} : {},
        ...event.by.person && !event.by.owner ? {member: event.by.person} : {}})
    heard.set(event.project, changes)
    timer ??= setTimeout(() => {
        timer = undefined
        const now = [...heard]
        heard.clear()
        void (async () => {
            for (const [project, changes] of now) {
                await tellScope(project, changes).catch(error => console.error(`[orrery] telling ${project}'s sessions what their issues moved under:`, error))
            }
        })()
    }, SCOPE_AFTER)
}

/** Tells the session on each started issue the changes reach, one message a session. Says how many were sent. */
export async function tellScope(project: string, changes: Change[]): Promise<number> {
    const store = useStore()
    const board = await store.listIssues(project)
    const byId = new Map(board.map(issue => [issue.id, issue]))
    const kids = new Map<string, IssueRecord[]>()
    for (const issue of board) if (issue.parent) kids.set(issue.parent, [...kids.get(issue.parent) ?? [], issue])
    /** The issue and those under it, a sub-issue with an epic of its own left out for an epic's change. */
    const under = (id: string, epic: boolean): IssueRecord[] => {
        const issue = byId.get(id)
        if (!issue) return []
        return [issue, ...(kids.get(id) ?? []).filter(kid => !epic || !kid.epic).flatMap(kid => under(kid.id, epic))]
    }
    /** An issue's epic: its own, else the one above it's. */
    const epicOf = (issue: IssueRecord | undefined): number | null | undefined => issue && (issue.epic ?? (issue.parent ? epicOf(byId.get(issue.parent)) : null))

    const milestones = new Map((await store.listMilestones(project)).map(m => [m.id, m.title]))
    const epics = new Map((await store.epics()).map(e => [String(e.id), e.title]))
    const milestone = (id?: string) => id ? `milestone ${id}${milestones.has(id) ? ` "${milestones.get(id)}"` : ' (deleted)'}` : 'no milestone'
    const epic = (id?: string) => id ? `epic ${id}${epics.has(id) ? ` "${epics.get(id)}"` : ' (deleted)'}` : 'no epic'

    // Each change, the issues it reaches and what to say about each.
    const lines: {issues: IssueRecord[], say: (id: string) => string, member?: string}[] = []
    for (const {type, subject, from, to, member} of changes) {
        if (type === 'issue.milestone' || type === 'issue.epic') {
            const isEpic = type === 'issue.epic'
            const name = isEpic ? epic : milestone
            const moved = `moved from ${name(from)} to ${name(to)}.`
            lines.push({issues: under(subject, isEpic), say: id => id === subject ? `${id} ${moved}` : `${id}, under ${subject}, ${moved}`, member})
        } else if (type === 'milestone.changed') {
            lines.push({issues: board.filter(i => i.milestone === subject), say: id => `${milestone(subject)}, which ${id} is in, changed its title or summary.`, member})
        } else {
            lines.push({issues: board.filter(i => String(epicOf(i) ?? '') === subject), say: id => `${epic(subject)}, which ${id} is under, changed its title or notes.`, member})
        }
    }

    const told = new Map<string, Set<string>>()
    for (const {issues, say, member} of lines) {
        for (const issue of issues) {
            if (issue.kind !== 'started') continue
            const session = await store.workerOf(project, issue.id)
            if (!session || (member && store.sessionPerson(session) !== member)) continue
            told.set(session, (told.get(session) ?? new Set<string>()).add(say(issue.id)))
        }
    }
    const owner = {name: (await store.ownerOf()).name, owner: true}
    for (const [session, said] of told) {
        await store.messageSession(project, session, `What an issue you're working on sits under changed:\n${[...said].map(l => `- ${l}`).join('\n')}\nRead it again (the \`issue\` tool) if that changes what's wanted.`, owner)
    }
    return told.size
}
