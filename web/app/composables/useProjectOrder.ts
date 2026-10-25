import type {Project} from '#shared/roadmap'

// The order the projects are shown in, as arranged in the sidebar and remembered in this browser.
// Projects not placed yet (new ones) come after, by name.
export function useProjectOrder() {
    const {projects} = useRoadmaps()
    const order = useState<string[]>('project-order', () => {
        try {
            const stored = JSON.parse(localStorage.getItem('orrery-project-order') ?? '[]')
            return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []
        } catch {
            return []
        }
    })

    const ordered = computed<Project[]>(() => {
        const at = (p: Project) => {
            const i = order.value.indexOf(p.id)
            return i < 0 ? Number.MAX_SAFE_INTEGER : i
        }
        return [...projects.value].sort((a, b) => at(a) - at(b) || a.name.localeCompare(b.name))
    })

    /** Puts `id` at `index` among the projects as they're shown now. */
    function move(id: string, index: number) {
        const ids = ordered.value.map(p => p.id).filter(other => other !== id)
        ids.splice(Math.max(0, Math.min(index, ids.length)), 0, id)
        order.value = ids
        try {
            localStorage.setItem('orrery-project-order', JSON.stringify(ids))
        } catch {
            // Private windows may refuse; the order still holds until a reload.
        }
    }

    return {ordered, move}
}
