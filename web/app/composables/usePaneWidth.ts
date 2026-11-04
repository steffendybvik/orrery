// How wide a split page's first pane is (UiSplitter), or how tall the sidebar's sessions are (ORR-897), in pixels,
// remembered in this browser under `key`. Back at `initial`, it's forgotten, so a later change to the default still reaches it.
export function usePaneWidth(key: string, initial: number) {
    const width = useState<number>(`pane-width:${key}`, () => {
        try {
            const stored = Number(localStorage.getItem(key))
            return Number.isFinite(stored) && stored > 0 ? stored : initial
        } catch {
            return initial
        }
    })
    watch(width, next => {
        try {
            if (next === initial) localStorage.removeItem(key)
            else localStorage.setItem(key, String(Math.round(next)))
        } catch {
            // Private windows may refuse; it still holds until a reload.
        }
    })
    return {width, initial}
}
