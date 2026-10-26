import type {DocSummary, Issue, Project} from '#shared/roadmap'

// What changed since the owner last looked: an issue (a comment touches it too) or a doc whose `updated_at`
// is past when they last opened it, remembered in this browser. Rows mark it with a quiet accent dot until
// it's opened; a done or canceled issue never is. The owner's own changes don't count: what they made starts seen, and a write from this page
// marks what it wrote to as seen once the change comes back. Everything from before the first visit is seen.
// A doc's text is kept as read too, so opening it again tints what changed in it since.
interface Seen {
    since: string
    /** Each issue's or doc's `updated_at` when it was last seen, by its key. */
    items: Record<string, string>
}

const STORAGE = 'orrery-seen'
/** Each doc's text as the owner last read it, by its key, so what changed since can be shown in it. */
const READ = 'orrery-read-docs'
/** Longer docs aren't kept: the browser's storage is small. */
const READ_LIMIT = 200_000
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
    const isNew = (key: string, item: {created_by: string, created_at: string, updated_at: string}) =>
        item.updated_at > seenAt(key) && !(item.created_by === name.value && item.updated_at === item.created_at)

    /** A closed (done or canceled) issue is never news: what happens to finished work can wait to be looked up. */
    const issueUnseen = (project: string, issue: Issue) => !isClosed(issue.kind) && isNew(issueKey(project, issue.id), issue)
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

    const seeIssue = (project: string, issue: Issue) => mark([[issueKey(project, issue.id), issue.updated_at]])
    const seeDoc = (project: string, doc: DocSummary) => mark([[docKey(project, doc.id), doc.updated_at]])

    /** The doc's text as last read here, if it was. */
    function lastRead(project: string, id: string): string | undefined {
        try {
            return (JSON.parse(localStorage.getItem(READ) ?? '{}') as Record<string, string>)[docKey(project, id)]
        } catch {
            return undefined
        }
    }

    /** Keeps the doc's text as read now. */
    function read(project: string, id: string, body: string) {
        try {
            const all = JSON.parse(localStorage.getItem(READ) ?? '{}') as Record<string, string>
            if (body.length > READ_LIMIT) delete all[docKey(project, id)]
            else all[docKey(project, id)] = body
            localStorage.setItem(READ, JSON.stringify(all))
        } catch {
            // Full or refused: the next visit shows no changes, as on a first one.
        }
    }

    /** Everything in the project marked seen. */
    function seeAll(project: Project) {
        mark([
            ...allIssues(project).map(({issue}): [string, string] => [issueKey(project.id, issue.id), issue.updated_at]),
            ...project.docs.map((doc): [string, string] => [docKey(project.id, doc.id), doc.updated_at]),
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
            ...allIssues(project).map(({issue}): [string, string] => [issueKey(project.id, issue.id), issue.updated_at]),
            ...project.docs.map((doc): [string, string] => [docKey(project.id, doc.id), doc.updated_at]),
        ]
        const own = items.filter(([key, at]) => now - (wrote.value[key] ?? 0) < OWN_FOR && at > seenAt(key))
        if (!own.length) return
        mark(own)
        const left = {...wrote.value}
        for (const [key] of own) delete left[key]
        wrote.value = left
    }

    return {issueUnseen, docUnseen, seeIssue, seeDoc, seeAll, unseenIn, wroteTo, ownChanges, lastRead, read}
}
