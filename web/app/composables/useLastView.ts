export type View = 'board' | 'list'
export type Grouping = 'status' | 'milestone'
export type Sorting = 'order' | 'risk'

// How the issues were last shown in this browser: as a list (the default) or a board, and the
// list grouped by status (the default) or by milestone, and sorted in the board's order (the default) or riskiest first (ORR-879).
export function useLastView() {
    const view = remembered<View>('orrery-issues-view', 'list', ['board', 'list'])
    const group = remembered<Grouping>('orrery-issues-group', 'status', ['status', 'milestone'])
    const sort = remembered<Sorting>('orrery-issues-sort', 'order', ['order', 'risk'])
    return {view, group, sort}
}

function remembered<T extends string>(key: string, fallback: T, values: T[]) {
    const state = useState<T>(key, () => {
        try {
            const stored = localStorage.getItem(key) as T | null
            return stored && values.includes(stored) ? stored : fallback
        } catch {
            return fallback
        }
    })
    watch(state, next => {
        try {
            localStorage.setItem(key, next)
        } catch {
            // Private windows may refuse; it still holds until a reload.
        }
    })
    return state
}
