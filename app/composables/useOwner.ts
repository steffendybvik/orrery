// The owner's name, sent as `Orrery-Actor` on what the page does on the owner's behalf (a focus
// signal), so sessions know it came from the owner.
export function useOwner() {
    const name = useState<string | null>('owner', () => null)
    async function load(): Promise<string> {
        name.value ??= (await $fetch<{name: string}>('/api/owner')).name
        return name.value
    }
    return {name, load}
}
