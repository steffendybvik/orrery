import type {Project} from '#shared/roadmap'

/** Where a project stands in the sidebar: first, as it is, or folded away under Hidden. */
export type ProjectPlace = 'starred' | 'normal' | 'hidden'
export const PROJECT_PLACES: {value: ProjectPlace, label: string}[] = [{value: 'starred', label: 'Starred'}, {value: 'normal', label: 'Shown'}, {value: 'hidden', label: 'Hidden'}]

// The order the projects are shown in, as arranged in the sidebar and remembered in this browser: starred ones first
// (App settings → Projects, ORR-836), then the rest. Projects not placed yet (new ones) come after, by name.
// `shown` leaves out the hidden ones, which the sidebar folds away; `ordered` keeps them, for the pickers and palette.
export function useProjectOrder() {
    const {projects} = useRoadmaps()
    const {settings} = useAppSettings()
    const order = useState<string[]>('project-order', () => {
        try {
            const stored = JSON.parse(localStorage.getItem('orrery-project-order') ?? '[]')
            return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []
        } catch {
            return []
        }
    })

    const isStarred = (id: string) => settings.value.starred.includes(id)
    const isHidden = (id: string) => settings.value.hidden.includes(id)
    const placeOf = (id: string): ProjectPlace => isHidden(id) ? 'hidden' : isStarred(id) ? 'starred' : 'normal'

    const ordered = computed<Project[]>(() => {
        const at = (p: Project) => {
            const i = order.value.indexOf(p.id)
            return i < 0 ? Number.MAX_SAFE_INTEGER : i
        }
        return [...projects.value].sort((a, b) => Number(isStarred(b.id)) - Number(isStarred(a.id)) || at(a) - at(b) || a.name.localeCompare(b.name))
    })
    const shown = computed(() => ordered.value.filter(p => !isHidden(p.id)))
    const hidden = computed(() => ordered.value.filter(p => isHidden(p.id)))

    /** Puts `id` at `index` among `among` (the projects as they're shown, by default all of them), keeping where
     * the others not in it stand. */
    function move(id: string, index: number, among: Project[] = ordered.value) {
        const list = among.map(p => p.id).filter(other => other !== id)
        const ids = ordered.value.map(p => p.id).filter(other => other !== id)
        const before = list[Math.max(0, index)]
        const last = list.at(-1)
        ids.splice(before !== undefined ? ids.indexOf(before) : last !== undefined ? ids.indexOf(last) + 1 : ids.length, 0, id)
        order.value = ids
        try {
            localStorage.setItem('orrery-project-order', JSON.stringify(ids))
        } catch {
            // Private windows may refuse; the order still holds until a reload.
        }
    }

    /** Stars, hides or puts back a project (App settings → Projects): never both starred and hidden. */
    function place(id: string, as: ProjectPlace) {
        const starred = settings.value.starred.filter(other => other !== id)
        const hiddenIds = settings.value.hidden.filter(other => other !== id)
        if (as === 'starred') starred.push(id)
        if (as === 'hidden') hiddenIds.push(id)
        return useAppSettings().save({starred, hidden: hiddenIds})
    }

    return {ordered, shown, hidden, isStarred, isHidden, placeOf, move, place}
}
