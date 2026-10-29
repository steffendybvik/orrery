import type {AllPulls} from '#shared/roadmap'

// Every open pull request on the projects' GitHub repos (ORR-491), as `GET /api/pulls` last had them: the Pull requests
// page's list, and the sidebar's count of those needing someone. The sidebar asks every two minutes while the tab is
// visible and the page every minute; orrery keeps GitHub's answer a minute (five without a token), so this is cheap.
export function useOpenPulls() {
    const pulls = useState<AllPulls | null>('open-pulls', () => null)
    async function load() {
        pulls.value = await $fetch<AllPulls>('/api/pulls').catch(() => pulls.value)
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
    return {pulls, load, follow}
}
