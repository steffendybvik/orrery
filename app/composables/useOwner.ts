// The owner's name, sent as `Orrery-Actor` on what the page does on the owner's behalf (a focus
// signal), so sessions know it came from the owner; and the name the page shows for them (`who`).
export function useOwner() {
    const owner = useState<{name: string, display: string} | null>('owner', () => null)
    const name = computed(() => owner.value?.name ?? null)
    async function load(): Promise<string> {
        owner.value ??= await $fetch<{name: string, display: string}>('/api/owner')
        return owner.value.name
    }
    /** The name to show for an actor: the owner's display name for the owner, anyone else as they are. */
    function who(actor: string) {
        return owner.value && actor.toLowerCase() === owner.value.name.toLowerCase() ? owner.value.display : actor
    }
    return {name, load, who}
}
