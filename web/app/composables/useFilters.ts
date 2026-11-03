import type {Column, Issue} from '#shared/roadmap'
import {isBlocked} from '#shared/roadmap'

export interface Filters {
    /** P1, P2, P3 or `none`; empty shows all. */
    priorities: string[]
    columns: Column[]
    /** Names, or `none` for unassigned issues; empty shows all. */
    assignees: string[]
    /** An issue with any of these labels; empty shows all. */
    labels: string[]
    /** `blocked` for issues waiting on others not closed yet (ORR-601), `ready` for the rest; empty shows all. */
    blocked: ('blocked' | 'ready')[]
    /** Project ids, on My issues, across projects; empty shows all. A project's own pages ignore it. */
    projects: string[]
    query: string
}

const none = (): Filters => ({priorities: [], columns: [], assignees: [], labels: [], blocked: [], projects: [], query: ''})

// The filters over issues (priority, column, assignee, label, blocked or ready, text in the id or title), shared by every view, and
// the project, on the views across projects.
// They start on the open columns (Done and Canceled left out, whatever the statuses are called), ticked in
// the Status filter, which reads that as not set (`usualColumns`); `changed` says they've moved off it, and `clear` goes back to it.
export function useFilters() {
    const filters = useState<Filters>('filters', none)
    const {columns: all, statuses} = useStatuses()
    const open = computed(() => all.value.filter(c => !isClosed(c.kind)).map(c => c.id))
    const defaults = (): Filters => ({...none(), columns: [...open.value]})
    /** What the Status filter starts on, once the statuses are known: until then nothing's ticked, and that's as usual too. */
    const usualColumns = computed(() => statuses.value.length ? open.value : [])

    // The statuses arrive with the settings, so the open columns are ticked once they're known. Until then
    // the only column is Proposed, which ticked alone would hide every other issue.
    const seeded = useState('filters-seeded', () => false)
    if (import.meta.client && !seeded.value) {
        const stop = watch(open, columns => {
            if (seeded.value || !statuses.value.length) return
            seeded.value = true
            if (!filters.value.columns.length) filters.value.columns = [...columns]
            queueMicrotask(() => stop())
        }, {immediate: true})
    }

    const active = computed(() => {
        const {priorities, columns, assignees, labels, blocked, query} = filters.value
        return !!(priorities.length || columns.length || assignees.length || labels.length || blocked.length || query.trim())
    })
    const changed = computed(() => {
        const {priorities, columns, assignees, labels, blocked, query} = filters.value
        const same = columns.length === open.value.length && columns.every(c => open.value.includes(c))
        return !!(priorities.length || !same || assignees.length || labels.length || blocked.length || query.trim())
    })

    function matches(issue: Issue): boolean {
        const {priorities, columns, assignees, labels, blocked, query} = filters.value
        const text = query.trim().toLowerCase()
        return (!priorities.length || priorities.includes(issue.priority ?? 'none'))
            && (!columns.length || columns.includes(issue.column))
            && (!assignees.length || assignees.includes(issue.assignee ?? 'none'))
            && (!labels.length || issue.labels.some(l => labels.includes(l)))
            && (!blocked.length || blocked.includes(isBlocked(issue) ? 'blocked' : 'ready'))
            && (!text || issue.id.toLowerCase().includes(text) || issue.title.toLowerCase().includes(text))
    }

    /** Whether a project's issues show on a page across projects. */
    function shows(project: string): boolean {
        return !filters.value.projects.length || filters.value.projects.includes(project)
    }

    function clear() {
        filters.value = defaults()
    }

    return {filters, active, changed, usualColumns, matches, shows, clear}
}
