import type {Epic} from '#shared/roadmap'

// The epics (ORR-895), as `GET /api/epics` has them, each with its progress across projects. Read once a page asks,
// and again when one is made, changed or deleted (`/api/events`' `epics`), or when a project the page holds changes, as
// an issue joining one or moving on changes its progress.
export function useEpics() {
    const epics = useState<Epic[] | null>('epics', () => null)
    const failed = useState('epics-failed', () => '')
    const latest = useState('epics-asked', () => 0)
    async function load() {
        const asked = ++latest.value
        try {
            const read = await apiFetch<Epic[]>('/epics')
            if (asked !== latest.value) return
            epics.value = read
            failed.value = ''
        } catch (error) {
            if (asked === latest.value) failed.value = errorMessage(error)
        }
    }
    const byId = (id: number) => epics.value?.find(e => e.id === id)
    return {epics, failed, load, byId}
}

/** `useEpics`, read now if it hasn't been, and again as the projects change. For a page or a component that shows them. */
export function useLiveEpics() {
    const all = useEpics()
    const {projects} = useRoadmaps()
    const heard = computed(() => projects.value.map(p => `${p.id}:${p.updated_at}`).join(' '))
    watch(heard, () => void all.load())
    onMounted(() => {
        if (!all.epics.value) void all.load()
    })
    return all
}
