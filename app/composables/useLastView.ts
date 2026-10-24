export type View = 'board' | 'list'

// The issues view (board or list) last picked, remembered in this browser.
export function useLastView() {
    const view = useState<View>('last-view', () => {
        try {
            return localStorage.getItem('orrery-view') === 'list' ? 'list' : 'board'
        } catch {
            return 'board'
        }
    })
    watch(view, next => {
        try {
            localStorage.setItem('orrery-view', next)
        } catch {
            // Private windows may refuse; it still holds until a reload.
        }
    })
    return {view}
}
