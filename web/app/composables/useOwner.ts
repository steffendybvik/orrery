import type {Owner} from '#shared/roadmap'

// The owner's id, sent as `Orrery-Actor` on what the page does on the owner's behalf (a focus signal),
// so sessions know it came from the owner; the name the page shows for them (`who`); and naming them,
// which the page asks for on first open.
export function useOwner() {
    const owner = useState<Owner | null>('owner', () => null)
    const name = computed(() => owner.value?.name ?? null)
    const named = computed(() => owner.value?.named ?? true)
    async function load(): Promise<string> {
        owner.value ??= await $fetch<Owner>('/api/owner')
        return owner.value.name
    }
    /** The name to show for an actor: the owner's display name for the owner, anyone else as they are. */
    function who(actor: string) {
        return owner.value && actor.toLowerCase() === owner.value.name.toLowerCase() ? owner.value.display : actor
    }
    /** Gives the owner's name (or changes it), as the owner: their id follows it. */
    async function rename(display: string) {
        const headers = {'Orrery-Actor': await load()}
        owner.value = await $fetch<Owner>('/api/owner', {method: 'PUT', headers, body: {name: display}})
    }
    return {owner, name, named, load, who, rename}
}
