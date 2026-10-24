import type {Column, Issue} from '#shared/roadmap'

export interface Filters {
    /** P1, P2, P3 or `none`; empty shows all. */
    priorities: string[]
    columns: Column[]
    query: string
}

// The filters over issues (priority, column, text in the id or title), shared by every view.
export function useFilters() {
    const filters = useState<Filters>('filters', () => ({priorities: [], columns: [], query: ''}))
    const active = computed(() => !!(filters.value.priorities.length || filters.value.columns.length || filters.value.query.trim()))

    function matches(issue: Issue): boolean {
        const {priorities, columns, query} = filters.value
        const text = query.trim().toLowerCase()
        return (!priorities.length || priorities.includes(issue.priority ?? 'none'))
            && (!columns.length || columns.includes(issue.column))
            && (!text || issue.id.toLowerCase().includes(text) || issue.title.toLowerCase().includes(text))
    }

    function clear() {
        filters.value = {priorities: [], columns: [], query: ''}
    }

    return {filters, active, matches, clear}
}
