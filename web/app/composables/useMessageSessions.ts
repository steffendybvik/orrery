import type {Session} from '#shared/roadmap'

// The dialogs that message sessions from any page (ORR-679): to every listening session, or to one, and which of them
// can hear it.
export function useMessageSessions() {
    const {sessions} = useRoadmaps()
    const all = useState('message-sessions', () => false)
    const one = useState<Session | null>('message-session', () => null)
    /** Every session that can hear a message, once each, as one hearing several projects is listed on each. */
    const listening = computed(() => [...new Map(Object.values(sessions.value).flat().filter(s => s.listening).map(s => [s.id, s])).values()])
    return {all, one, listening}
}
