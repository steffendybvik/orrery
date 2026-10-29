import type {AllPulls} from '#shared/roadmap'

// Every open pull request on the projects' GitHub repos (ORR-491), as `GET /api/pulls` last had them: the Pull requests
// page's list, and the count of those needing someone on App settings → Advanced (ORR-565) and in the sidebar
// (ORR-578). Both ask every two minutes while the tab is visible and the page every minute; orrery keeps GitHub's answer a minute (five without a token), so this is cheap.
// `poll` is the page's Poll now: GitHub asked at once, and the fresh list back (ORR-534).
export function useOpenPulls() {
    const pulls = useState<AllPulls | null>('open-pulls', () => null)
    async function load() {
        pulls.value = await $fetch<AllPulls>('/api/pulls').catch(() => pulls.value)
    }
    const polling = ref(false)
    const failed = ref('')
    /** Polls GitHub now for every repo, and shows what it read: each repo held back says why on its line. */
    async function poll() {
        if (polling.value) return
        polling.value = true
        failed.value = ''
        try {
            pulls.value = await $fetch<AllPulls>('/api/pulls/poll', {method: 'POST', headers: {'Orrery-Actor': await useOwner().load()}})
        } catch (error) {
            failed.value = errorMessage(error, 'poll')
        } finally {
            polling.value = false
        }
    }
    /** Loads now and every `every` ms while the tab is visible, until the calling component goes. */
    function follow(every: number) {
        let timer: ReturnType<typeof setInterval> | undefined
        onMounted(() => {
            void load()
            timer = setInterval(() => {
                if (document.visibilityState === 'visible') void load()
            }, every)
        })
        onBeforeUnmount(() => clearInterval(timer))
    }
    return {pulls, load, follow, poll, polling, failed}
}
