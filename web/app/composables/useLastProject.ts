import {defaultProject} from '~/utils/default-project'

const KEY = 'orrery-last-project'

// The project last opened in this browser (a page of its own), remembered so a page of no project, such as the chat
// or Context, opens on it rather than on the first by name (ORR-1284). `preferred` is that pick (`defaultProject`).
export function useLastProject() {
    const last = useState<string | null>(KEY, () => {
        try {
            return localStorage.getItem(KEY)
        } catch {
            return null
        }
    })
    const {ordered, isStarred, isHidden} = useProjectOrder()

    function used(id: string) {
        if (last.value === id) return
        last.value = id
        try {
            localStorage.setItem(KEY, id)
        } catch {
            // Private windows may refuse; it still holds until a reload.
        }
    }

    const preferred = computed(() => defaultProject(ordered.value, last.value, isStarred, isHidden))
    return {last, used, preferred}
}
