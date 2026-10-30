import type {AllPulls} from '#shared/roadmap'

// Every open pull request on the projects' GitHub repos (ORR-491), as `GET /api/pulls` last had them: the Pull requests
// page's list, and the count of those needing someone on App settings → Advanced (ORR-565) and in the sidebar
// (ORR-578). Both ask every two minutes while the tab is visible and the page every minute; orrery keeps GitHub's answer a minute (five without a token), so this is cheap.
// The page asks for its `page` of them, 50 to a page (ORR-615), and keeps it apart; the counts ask for one, as they
// show only `open` and `needs`.
// `poll` is the page's Poll now: GitHub asked at once, and the fresh list back (ORR-534).
export function useOpenPulls(page?: Ref<number>) {
    const pulls = useState<AllPulls | null>(page ? 'open-pulls-page' : 'open-pulls', () => null)
    const query = () => page ? {page: page.value} : {limit: 1}
    async function load() {
        pulls.value = await $fetch<AllPulls>('/api/pulls', {query: query()}).catch(() => pulls.value)
    }
    const polling = ref(false)
    const failed = ref('')
    /** Polls GitHub now for every repo, and shows what it read: each repo held back says why on its line. */
    async function poll() {
        if (polling.value) return
        polling.value = true
        failed.value = ''
        try {
            pulls.value = await $fetch<AllPulls>('/api/pulls/poll', {method: 'POST', query: query(), headers: {'Orrery-Actor': await useOwner().load()}})
        } catch (error) {
            failed.value = errorMessage(error, 'poll')
        } finally {
            polling.value = false
        }
    }
    /** Loads now, every `every` ms while the tab is visible, and when the page changes, until the calling component goes. */
    function follow(every: number) {
        let timer: ReturnType<typeof setInterval> | undefined
        onMounted(() => {
            void load()
            timer = setInterval(() => {
                if (document.visibilityState === 'visible') void load()
            }, every)
        })
        if (page) watch(page, () => void load())
        onBeforeUnmount(() => clearInterval(timer))
    }
    return {pulls, load, follow, poll, polling, failed}
}
