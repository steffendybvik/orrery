import type {LoggedEvent} from '#shared/roadmap'

// The event log as the page has it (ORR-322), kept current from `/api/events` (`logged`): the Events page's list, and
// the new kinds of error since the owner last looked, which the bell counts while Advanced is on. Each tab remembers
// when it last looked in localStorage.
export function useLoggedEvents() {
    const events = useState<LoggedEvent[]>('logged-events', () => [])
    const loaded = useState('logged-events-loaded', () => false)
    /** The errors that are a row of their own since this tab last looked, by id: a repeat of one already seen isn't new. */
    const fresh = useState<LoggedEvent[]>('logged-events-fresh', () => [])
    const seenAt = useState<string>('logged-events-seen', () => {
        try {
            return localStorage.getItem('orrery-events-seen') ?? new Date().toISOString()
        } catch {
            return new Date().toISOString()
        }
    })
    const {settings} = useAppSettings()
    /** New kinds of error not looked at yet, for the bell; none while Advanced is off. One an agent resolved still counts
     * until the owner looks, so a session can't hide what it caused (ORR-420). */
    const newErrors = computed(() => settings.value.advanced ? fresh.value.filter(e => (!e.resolved_at || e.resolved_by) && e.first_seen > seenAt.value) : [])

    async function load() {
        events.value = await $fetch<LoggedEvent[]>('/api/events/log', {query: {limit: 500}}).catch(() => events.value)
        loaded.value = true
    }

    /** The errors that started since the owner last looked and are still theirs to see (unresolved, or resolved by an
     * agent), for the bell after a reload. */
    async function loadNew() {
        if (!settings.value.advanced) return
        fresh.value = await $fetch<LoggedEvent[]>('/api/events/log', {query: {level: 'error', since: seenAt.value}})
            .then(found => found.filter(e => (!e.resolved_at || e.resolved_by) && e.first_seen > seenAt.value)).catch(() => fresh.value)
    }

    function arrived(event: LoggedEvent, isFresh: boolean) {
        if (loaded.value) events.value = [event, ...events.value.filter(e => e.id !== event.id)].slice(0, 500)
        if (event.level === 'error' && isFresh) fresh.value = [event, ...fresh.value.filter(e => e.id !== event.id)].slice(0, 50)
        else fresh.value = fresh.value.map(e => e.id === event.id ? event : e)
    }

    /** The owner has looked: what's there now isn't new any more. */
    function seen() {
        seenAt.value = new Date().toISOString()
        fresh.value = []
        try {
            localStorage.setItem('orrery-events-seen', seenAt.value)
        } catch {
            // Private mode: it's seen for as long as the tab is open.
        }
    }

    async function resolve(id: number) {
        const event = await $fetch<LoggedEvent>(`/api/events/log/${id}/resolve`, {method: 'POST', headers: {'Orrery-Actor': await useOwner().load()}})
        arrived(event, false)
    }

    return {events, loaded, newErrors, seenAt, load, loadNew, arrived, seen, resolve}
}
