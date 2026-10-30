import type {Person} from '#shared/roadmap'

// The people on this orrery (ORR-657), read as the page opens. With one person none of it shows. With more and login off,
// as for trying it out on one machine, this browser picks who it's acting as, which sets the `Orrery-Actor` it sends; that's
// a name, not a login. With login on, the login says who you are.
const KEY = 'orrery-acting'

export function usePeople() {
    const people = useState<Person[]>('people', () => [])
    const acting = useState<string | null>('acting', () => null)
    const {status} = useAuth()
    const here = computed(() => people.value.filter(person => !person.removed_at))
    const shared = computed(() => here.value.length > 1)
    const owner = computed(() => here.value.find(person => person.role === 'owner')?.id ?? null)
    /** Who this browser is: logged in, or acting as someone, or else the owner. */
    const me = computed(() => status.value?.person ?? acting.value ?? owner.value)
    /** Whether this browser may pick who it's acting as. */
    const picks = computed(() => shared.value && status.value?.mode === 'off')

    async function load() {
        people.value = await apiFetch<Person[]>('/people').catch(() => [])
        const kept = localStorage.getItem(KEY)
        acting.value = picks.value && kept && kept !== owner.value && here.value.some(person => person.id === kept) ? kept : null
    }
    /** Acts as `person` from now on, reading everything again as them. */
    function actAs(person: string) {
        localStorage.setItem(KEY, person)
        location.reload()
    }
    const nameOf = (id: string) => people.value.find(person => person.id === id)?.name ?? id
    return {people, here, shared, owner, me, picks, load, actAs, nameOf}
}
