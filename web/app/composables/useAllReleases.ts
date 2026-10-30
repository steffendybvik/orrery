import type {ProjectReleases} from '#shared/roadmap'

// Every project's releases, as `GET /api/releases` has them, for the Releases page (ORR-671). The projects the page
// already holds carry their releases and are patched as they change, so it asks again only when those differ: a
// shipped release or a moved issue shows at once, and every other write asks for nothing.
export function useAllReleases() {
    const {projects} = useRoadmaps()
    const cards = ref<ProjectReleases[] | null>(null)
    const failed = ref('')
    let latest = 0
    async function load() {
        const asked = ++latest
        try {
            const read = await $fetch<ProjectReleases[]>('/api/releases')
            if (asked !== latest) return
            cards.value = read
            failed.value = ''
        } catch (error) {
            if (asked === latest) failed.value = errorMessage(error)
        }
    }
    const heard = computed(() => JSON.stringify(projects.value.map(p => [p.id, p.release_mode, p.releases_from, p.releases])))
    watch(heard, () => void load())
    onMounted(load)
    return {cards, failed}
}
