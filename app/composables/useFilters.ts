import type {Column, Issue} from '#shared/roadmap'

export interface Filters {
    /** P1, P2, P3 or `none`; empty shows all. */
    priorities: string[]
    columns: Column[]
    /** Names, or `none` for unassigned issues; empty shows all. */
    assignees: string[]
    /** An issue with any of these labels; empty shows all. */
    labels: string[]
    query: string
}

const none = (): Filters => ({priorities: [], columns: [], assignees: [], labels: [], query: ''})

// The filters over issues (priority, column, assignee, label, text in the id or title), shared by every view.
export function useFilters() {
    const filters = useState<Filters>('filters', none)
    const active = computed(() => {
        const {priorities, columns, assignees, labels, query} = filters.value
        return !!(priorities.length || columns.length || assignees.length || labels.length || query.trim())
    })

    function matches(issue: Issue): boolean {
        const {priorities, columns, assignees, labels, query} = filters.value
        const text = query.trim().toLowerCase()
        return (!priorities.length || priorities.includes(issue.priority ?? 'none'))
            && (!columns.length || columns.includes(issue.column))
            && (!assignees.length || assignees.includes(issue.assignee ?? 'none'))
            && (!labels.length || issue.labels.some(l => labels.includes(l)))
            && (!text || issue.id.toLowerCase().includes(text) || issue.title.toLowerCase().includes(text))
    }

    function clear() {
        filters.value = none()
    }

    return {filters, active, matches, clear}
}
