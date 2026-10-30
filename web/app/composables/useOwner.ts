import type {Owner, Person} from '#shared/roadmap'

// The owner's id, sent as `Orrery-Actor` on what the page does on the owner's behalf (a focus signal),
// so sessions know it came from the owner; the name the page shows for them and for agents (`who`); and naming them,
// which the page asks for on first open.
export function useOwner() {
    const owner = useState<Owner | null>('owner', () => null)
    const name = computed(() => owner.value?.name ?? null)
    const named = computed(() => owner.value?.named ?? true)
    async function load(): Promise<string> {
        owner.value ??= await apiFetch<Owner>('/owner')
        return owner.value.name
    }
    /** Asks again, when the owner may have been renamed (in another tab), so writes don't go as the old id. */
    async function refresh() {
        owner.value = await apiFetch<Owner>('/owner').catch(() => owner.value)
    }
    /** The name to show for an actor: the owner's display name for the owner, the session's name when a session wrote it
     * (`session_name`, ORR-466), Agent for `claude`, a person by their name (ORR-657), anyone else as they are. */
    function who(actor: string, session?: string) {
        if (owner.value && actor.toLowerCase() === owner.value.name.toLowerCase()) return owner.value.display
        if (session) return session
        if (actor.toLowerCase() === 'claude') return 'Agent'
        return useState<Person[]>('people', () => []).value.find(person => person.id === actor.toLowerCase())?.name ?? actor
    }
    /** Gives the owner's name (or changes it), as the owner: their id follows it. */
    async function rename(display: string) {
        owner.value = await apiFetch<Owner>('/owner', {method: 'PUT', body: {name: display}})
    }
    return {owner, name, named, load, refresh, who, rename}
}
