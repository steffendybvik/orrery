// Which projects show their pages (Issues, Roadmap, Docs, Settings) in the sidebar, remembered in this
// browser. One never opened or folded is open only while you're on it.
export function useProjectFolds() {
    const route = useRoute()
    const folds = useState<Record<string, boolean>>('project-folds', () => {
        try {
            const stored = JSON.parse(localStorage.getItem('orrery-project-folds') ?? '{}')
            return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}
        } catch {
            return {}
        }
    })

    const isOpen = (id: string) => folds.value[id] ?? route.params.project === id

    /** Opens (or folds) every project in `ids`. */
    function set(ids: string[], open: boolean) {
        folds.value = {...folds.value, ...Object.fromEntries(ids.map(id => [id, open]))}
        try {
            localStorage.setItem('orrery-project-folds', JSON.stringify(folds.value))
        } catch {
            // Private windows may refuse; the folds still hold until a reload.
        }
    }

    const toggle = (id: string) => set([id], !isOpen(id))

    return {isOpen, set, toggle}
}
