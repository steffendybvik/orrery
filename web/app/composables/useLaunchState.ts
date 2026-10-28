// Whether a project's launcher is there and how many sessions it has started or has on their way, and every
// project's together, which the limit counts (`GET /launches`), shared by everything on the page that shows it:
// asked again when any project's launchers or sessions change, once however many show it. `install` is what installs the launcher, run
// in the project's repo: this orrery's checkout, where it knows it. `folders`: where its launchers run, so projects
// served from one repo can share a session; `every`: whether one runs where the channel serves every project (`*`).
export interface LaunchState {
    launchers: number
    /** The version each launcher runs; `''` from one too old to say. */
    versions: string[]
    folders: string[]
    every: boolean
    started: number
    starting: number
    total: number
}

/** The ask on its way for each project, so several asking at once share it. */
const asking = new Map<string, Promise<void>>()

export function useLaunchState(project: MaybeRefOrGetter<string>) {
    const all = useState<Record<string, LaunchState | null>>('launch-state', () => ({}))
    const {launchers, sessions} = useRoadmaps()
    const install = `node ${String(useRuntimeConfig().public.repoDir || '/path/to/orrery')}/channel/orrery-launcher.mjs --install`

    function refresh(): Promise<void> {
        const id = toValue(project)
        const already = asking.get(id)
        if (already) return already
        const ask = $fetch<LaunchState>(`/api/projects/${encodeURIComponent(id)}/launches`).catch(() => null)
            .then(state => {
                all.value = {...all.value, [id]: state}
            })
            .finally(() => asking.delete(id))
        asking.set(id, ask)
        return ask
    }
    watch(() => [toValue(project), launchers.value, sessions.value], refresh, {immediate: true})

    return {state: computed(() => all.value[toValue(project)] ?? null), refresh, install}
}
