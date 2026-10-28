import type {Session, SessionWork} from '#shared/roadmap'

// The session working an issue, for its page: the last one that wrote to it or was asked to focus on it (each
// session's open issues, `GET …/sessions/work`), while it's listening; none otherwise. Asked again as the project's
// sessions come, go or change state, as the issue changes, and as signals go out, so it shows up and goes live.
export function useIssueWorker(project: MaybeRefOrGetter<string>, issue: MaybeRefOrGetter<string | undefined>, changed?: MaybeRefOrGetter<string | undefined>) {
    const {sessions, signals} = useRoadmaps()
    const work = ref<Record<string, SessionWork>>({})
    const listening = computed(() => (sessions.value[toValue(project)] ?? []).filter(s => s.listening))

    async function refresh() {
        const id = toValue(project)
        // Before the issue's project is known there's nothing to ask about.
        if (!id) return
        const got = await $fetch<Record<string, SessionWork>>(`/api/projects/${encodeURIComponent(id)}/sessions/work`).catch(() => null)
        if (got && id === toValue(project)) work.value = got
    }
    watch(() => [toValue(project), toValue(changed), listening.value.map(s => `${s.id}:${s.state}`).join(), signals.value.length], refresh, {immediate: true})

    const worker = computed<Session | undefined>(() => {
        const id = toValue(issue)
        return id ? listening.value.find(s => work.value[s.id]?.issues.some(i => i.id === id)) : undefined
    })
    return {worker}
}
