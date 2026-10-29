import type {Session, SessionWork} from '#shared/roadmap'

// Which listening session is on which issue, for the rows and cards that mark it (ORR-536): what the sessions on each
// project are on (`GET /api/sessions/work`, one call for them all), asked once for the whole app, and again as
// sessions come, go or change state, as issues change (a session writing to one is what ties it there) and as
// signals go out. A project's sessions are its own and those whose channel also hears it, as on the issue's page
// (`useIssueWorker`). The watch lives outside any one page, so a row unmounting doesn't end it.
let watching = false

export function useWorkedIssues() {
    const {sessions, signals, changed} = useRoadmaps()
    const work = useState<Record<string, Record<string, SessionWork>>>('worked-issues', () => ({}))
    const listening = (project: string) => (sessions.value[project] ?? []).filter(s => s.listening)
    const heard = computed(() => Object.keys(sessions.value).filter(p => listening(p).length))

    if (!watching) {
        watching = true
        effectScope(true).run(() => watch(() => [
            heard.value.flatMap(p => listening(p).map(s => `${p}:${s.id}:${s.state}`)).join(), changed.value, signals.value.length,
        ], () => {
            if (!heard.value.length) return void (work.value = {})
            $fetch<Record<string, Record<string, SessionWork>>>('/api/sessions/work', {query: {projects: heard.value.join(',')}})
                .then(found => work.value = found)
                .catch(() => {})
        }, {immediate: true}))
    }

    /** The listening session working the project's issue, if one is. */
    function workerOf(project: string, issue: string): Session | undefined {
        return listening(project).find(s => work.value[project]?.[s.id]?.issues.some(i => i.id === issue))
    }
    return {workerOf}
}
