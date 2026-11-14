import {launcherInstall} from '#shared/connect'

// The line that connects this computer (ORR-1192). With login on, it carries a one-time code made for whoever's signed
// in, so pasting it connects the machine with no key to copy; a fresh one comes before it runs out. With login off, or
// for an agent, it's the plain line, which asks on the page to connect if the orrery wants a key.
const REFRESH = 12 * 60_000

export function useMachineLine() {
    const {status} = useAuth()
    const code = useState<string | null>('machine-line-code', () => null)
    const origin = serverOrigin()
    const line = computed(() => launcherInstall(origin, code.value ?? undefined))
    let timer: ReturnType<typeof setTimeout> | undefined

    async function fresh() {
        if (status.value?.mode !== 'on' || status.value.via !== 'browser') return
        try {
            code.value = (await apiFetch<{code: string}>('/machines/code', {method: 'POST'})).code
        } catch {
            code.value = null
        }
        timer = setTimeout(fresh, REFRESH)
    }
    onMounted(fresh)
    onBeforeUnmount(() => clearTimeout(timer))
    return line
}
