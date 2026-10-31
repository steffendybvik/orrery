import type {LaunchState} from '~/composables/useLaunchState'

export interface ServedRepo {
    dir: string
    projects: string[]
    picked_at?: string
    connected_at?: string
}

const earliest = (a: string | undefined, b: string | undefined) => !a || (b && b < a) ? b : a

/** The repos the launchers serve (ORR-605), each folder once with its projects, and when it was connected (Connect a repo)
 * or picked up (a Claude session's channel), the earliest of its projects'. Asked of each project, and again as
 * launchers come and go; nothing while none runs. `loaded` is false until the first answers are in. */
export function useLauncherRepos() {
    const {launchers, byId} = useRoadmaps()
    const {ordered} = useProjectOrder()
    const states = ref<Record<string, LaunchState | null>>({})
    const loaded = ref(false)
    async function ask() {
        const asked = await Promise.all(ordered.value.map(async p => [p.id, await apiFetch<LaunchState>(`/projects/${encodeURIComponent(p.id)}/launches`).catch(() => null)] as const))
        states.value = Object.fromEntries(asked)
        loaded.value = true
    }
    watch([() => ordered.value.map(p => p.id).join(), launchers], ask, {immediate: true})

    const repos = computed(() => {
        const byDir = new Map<string, ServedRepo>()
        for (const [project, state] of Object.entries(states.value)) {
            for (const {dir, picked_at, connected_at} of state?.repos ?? []) {
                const repo = byDir.get(dir) ?? {dir, projects: []}
                repo.projects.push(byId(project)?.name ?? project)
                repo.picked_at = earliest(repo.picked_at, picked_at)
                repo.connected_at = earliest(repo.connected_at, connected_at)
                byDir.set(dir, repo)
            }
        }
        return [...byDir.values()].sort((a, b) => a.dir.localeCompare(b.dir))
    })
    return {repos, loaded}
}
