import type {Owner} from '#shared/roadmap'

// The owner's id, sent as `Orrery-Actor` on what the page does on the owner's behalf (a focus signal),
// so sessions know it came from the owner; the name the page shows for them and for agents (`who`); and naming them,
// which the page asks for on first open.
export function useOwner() {
    const owner = useState<Owner | null>('owner', () => null)
    const name = computed(() => owner.value?.name ?? null)
    const named = computed(() => owner.value?.named ?? true)
    async function load(): Promise<string> {
        owner.value ??= await $fetch<Owner>('/api/owner')
        return owner.value.name
    }
    /** Asks again, when the owner may have been renamed (in another tab), so writes don't go as the old id. */
    async function refresh() {
        owner.value = await $fetch<Owner>('/api/owner').catch(() => owner.value)
    }
    /** The name to show for an actor: the owner's display name for the owner, Agent for `claude`, anyone else as they are. */
    function who(actor: string) {
        if (owner.value && actor.toLowerCase() === owner.value.name.toLowerCase()) return owner.value.display
        return actor.toLowerCase() === 'claude' ? 'Agent' : actor
    }
    /** Gives the owner's name (or changes it), as the owner: their id follows it. */
    async function rename(display: string) {
        const headers = {'Orrery-Actor': await load()}
        owner.value = await $fetch<Owner>('/api/owner', {method: 'PUT', headers, body: {name: display}})
    }
    return {owner, name, named, load, refresh, who, rename}
}
