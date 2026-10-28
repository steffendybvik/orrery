import type {Secret} from '#shared/roadmap'

// The orrery's secrets as the page sees them (names, hosts, last use; never a value), kept current from
// `/api/events`.
export function useSecretList() {
    const secrets = useState<Secret[]>('secrets', () => [])

    async function load() {
        secrets.value = await $fetch<Secret[]>('/api/secrets')
    }

    return {secrets, load}
}
