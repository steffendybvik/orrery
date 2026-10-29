import type {Session, SessionWork} from '#shared/roadmap'

// Which listening session is on which issue, for the rows and cards that mark it (ORR-536): what every project's
// sessions are on (`GET /api/sessions/work`, one call for them all), asked once for the whole app, and again as
// sessions come, go or change state and as signals go out. The watch lives outside any one page, so a row
// unmounting doesn't end it.
let watching = false

export function useWorkedIssues() {
    const {sessions, signals} = useRoadmaps()
    const work = useState<Record<string, Record<string, SessionWork>>>('worked-issues', () => ({}))
    const listening = computed(() => Object.values(sessions.value).flat().filter(s => s.listening))
    const homes = computed(() => [...new Set(listening.value.map(s => s.project))])

    if (!watching) {
        watching = true
        effectScope(true).run(() => watch(() => [listening.value.map(s => `${s.id}:${s.state}`).join(), signals.value.length], () => {
            if (!homes.value.length) return void (work.value = {})
            $fetch<Record<string, Record<string, SessionWork>>>('/api/sessions/work', {query: {projects: homes.value.join(',')}})
                .then(found => work.value = found)
                .catch(() => {})
        }, {immediate: true}))
    }

    /** The listening session working the project's issue, if one is. */
    function workerOf(project: string, issue: string): Session | undefined {
        return listening.value.find(s => (s.project === project || s.also?.includes(project))
            && work.value[s.project]?.[s.id]?.issues.some(i => i.id === issue))
    }
    return {workerOf}
}
