// Whether a project's launcher is there and how many sessions it has started or has on their way, and every
// project's together, which the limit counts (`GET /launches`), shared by everything on the page that shows it:
// asked again when any project's launchers or sessions change, once however many show it. `install` is what installs the launcher, run
// in the project's repo: this Orrery's checkout, where it knows it. `folders`: where its launchers run, so projects
// served from one repo can share a session; `every`: whether one runs where the channel serves every project (`*`).
export interface LaunchState {
    launchers: number
    folders: string[]
    every: boolean
    started: number
    starting: number
    total: number
}

/** The ask on its way for each project, so several asking at once share it; `again` when something changed while it
 * was on its way, so its answer may be from before, and it's asked once more (a launcher connecting as the page loads). */
const asking = new Map<string, {ask: Promise<void>, again: boolean}>()

export function useLaunchState(project: MaybeRefOrGetter<string>) {
    const all = useState<Record<string, LaunchState | null>>('launch-state', () => ({}))
    const {launchers, sessions} = useRoadmaps()
    const install = `node ${String(useRuntimeConfig().public.repoDir || '/path/to/orrery')}/channel/orrery-launcher.mjs --install`

    function refreshOf(id: string): Promise<void> {
        const already = asking.get(id)
        if (already) {
            already.again = true
            return already.ask
        }
        const asked = {again: false, ask: Promise.resolve()}
        asked.ask = $fetch<LaunchState>(`/api/projects/${encodeURIComponent(id)}/launches`).catch(() => null)
            .then(state => {
                all.value = {...all.value, [id]: state}
            })
            .finally(() => {
                asking.delete(id)
                if (asked.again) void refreshOf(id)
            })
        asking.set(id, asked)
        return asked.ask
    }
    const refresh = (): Promise<void> => toValue(project) ? refreshOf(toValue(project)) : Promise.resolve()
    watch(() => [toValue(project), launchers.value, sessions.value], refresh, {immediate: true})

    return {state: computed(() => all.value[toValue(project)] ?? null), refresh, install}
}
