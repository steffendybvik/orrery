import type {DocSummary, Issue, Project} from '#shared/roadmap'

// What changed since the owner last looked: an issue (a comment touches it too) or a doc whose `updatedAt`
// is past when they last opened it, remembered in this browser. Rows mark it with a quiet accent dot until
// it's opened. The owner's own changes don't count: what they made starts seen, and a write from this page
// marks what it wrote to as seen once the change comes back. Everything from before the first visit is seen.
interface Seen {
    since: string
    /** Each issue's or doc's `updatedAt` when it was last seen, by its key. */
    items: Record<string, string>
}

const STORAGE = 'orrery-seen'
/** How long a write from this page waits for the change it brings back (one that changed nothing brings none). */
const OWN_FOR = 10_000

const issueKey = (project: string, id: string) => `${project}/${id}`
const docKey = (project: string, id: string) => `${project}/docs/${id}`

export function useUnseen() {
    const seen = useState<Seen>('seen', () => {
        const fresh = {since: new Date().toISOString(), items: {}}
        try {
            const stored = JSON.parse(localStorage.getItem(STORAGE) ?? 'null')
            if (stored && typeof stored.since === 'string' && stored.items && typeof stored.items === 'object') return stored
            localStorage.setItem(STORAGE, JSON.stringify(fresh))
        } catch {
            // Private windows may refuse; it holds until a reload.
        }
        return fresh
    })
    /** When this page last wrote to each key. */
    const wrote = useState<Record<string, number>>('seen-wrote', () => ({}))
    const {name} = useOwner()

    const seenAt = (key: string) => {
        const at = seen.value.items[key]
        return at && at > seen.value.since ? at : seen.value.since
    }
    const isNew = (key: string, item: {createdBy: string, createdAt: string, updatedAt: string}) =>
        item.updatedAt > seenAt(key) && !(item.createdBy === name.value && item.updatedAt === item.createdAt)

    const issueUnseen = (project: string, issue: Issue) => isNew(issueKey(project, issue.id), issue)
    const docUnseen = (project: string, doc: DocSummary) => isNew(docKey(project, doc.id), doc)

    function mark(entries: [string, string][]) {
        const fresh = entries.filter(([key, at]) => at > seenAt(key))
        if (!fresh.length) return
        seen.value = {...seen.value, items: {...seen.value.items, ...Object.fromEntries(fresh)}}
        try {
            localStorage.setItem(STORAGE, JSON.stringify(seen.value))
        } catch {
            // As above.
        }
    }

    const seeIssue = (project: string, issue: Issue) => mark([[issueKey(project, issue.id), issue.updatedAt]])
    const seeDoc = (project: string, doc: DocSummary) => mark([[docKey(project, doc.id), doc.updatedAt]])

    /** Everything in the project marked seen. */
    function seeAll(project: Project) {
        mark([
            ...allIssues(project).map(({issue}): [string, string] => [issueKey(project.id, issue.id), issue.updatedAt]),
            ...project.docs.map((doc): [string, string] => [docKey(project.id, doc.id), doc.updatedAt]),
        ])
    }

    /** How many of the project's issues and docs changed since they were seen. */
    const unseenIn = (project: Project) => allIssues(project).filter(({issue}) => issueUnseen(project.id, issue)).length
        + project.docs.filter(doc => docUnseen(project.id, doc)).length

    /** Notes a write from this page to an API path, so the change it brings back isn't news. */
    function wroteTo(path: string) {
        const match = /^\/api\/projects\/([^/?]+)\/(issues|docs)\/([^/?]+)/.exec(path)
        if (!match) return
        const [, project, kind, id] = match.map(decodeURIComponent) as [string, string, string, string]
        wrote.value = {...wrote.value, [kind === 'docs' ? docKey(project, id) : issueKey(project, id)]: Date.now()}
    }

    /** Marks seen the change each write from this page brought back: only the first, so an agent's change
     * right after it is still news. */
    function ownChanges(project: Project) {
        const now = Date.now()
        const items: [string, string][] = [
            ...allIssues(project).map(({issue}): [string, string] => [issueKey(project.id, issue.id), issue.updatedAt]),
            ...project.docs.map((doc): [string, string] => [docKey(project.id, doc.id), doc.updatedAt]),
        ]
        const own = items.filter(([key, at]) => now - (wrote.value[key] ?? 0) < OWN_FOR && at > seenAt(key))
        if (!own.length) return
        mark(own)
        const left = {...wrote.value}
        for (const [key] of own) delete left[key]
        wrote.value = left
    }

    return {issueUnseen, docUnseen, seeIssue, seeDoc, seeAll, unseenIn, wroteTo, ownChanges}
}
