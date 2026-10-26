// Whether a project's launcher is there and how many sessions it has started or has on their way
// (`GET /launches`), shared by everything on the page that shows it: asked again only when the project's
// launchers or sessions change, once however many show it. `install` is what installs the launcher, run
// in the project's repo: this Orrery's checkout, where it knows it.
export interface LaunchState {
    launchers: number
    started: number
    starting: number
}

/** The ask on its way for each project, so several asking at once share it. */
const asking = new Map<string, Promise<void>>()

export function useLaunchState(project: MaybeRefOrGetter<string>) {
    const all = useState<Record<string, LaunchState | null>>('launch-state', () => ({}))
    const {launchers, sessions} = useRoadmaps()
    const install = `node ${String(useRuntimeConfig().public.repoDir || '/path/to/orrery')}/channel/orrery-launcher.mjs --install`

    function refresh(): Promise<void> {
        const id = toValue(project)
        // No project (App settings): nothing to ask.
        if (!id) return Promise.resolve()
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
    watch(() => [toValue(project), launchers.value[toValue(project)], sessions.value[toValue(project)]], refresh, {immediate: true})

    return {state: computed(() => all.value[toValue(project)] ?? null), refresh, install}
}
