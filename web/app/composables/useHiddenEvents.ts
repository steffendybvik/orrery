import type {EventLevel, LoggedEvent} from '#shared/roadmap'

// What the owner has filtered away on the Events page (ORR-379): levels switched off, and kinds hidden, each a kind
// (`backup.made`) or a family (`issue`, every `issue.…`). Kept per browser in localStorage, as when they last looked is.
const KEY = 'orrery-events-hidden'

interface Hidden {
    levels: EventLevel[]
    kinds: string[]
}

export function useHiddenEvents() {
    const hidden = useState<Hidden>('events-hidden', () => {
        try {
            const kept = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Hidden>
            return {levels: Array.isArray(kept.levels) ? kept.levels : [], kinds: Array.isArray(kept.kinds) ? kept.kinds : []}
        } catch {
            return {levels: [], kinds: []}
        }
    })

    function keep(next: Hidden) {
        hidden.value = next
        try {
            localStorage.setItem(KEY, JSON.stringify(next))
        } catch {
            // A browser that keeps nothing forgets it on reload.
        }
    }

    const levelShown = (level: EventLevel) => !hidden.value.levels.includes(level)
    function toggleLevel(level: EventLevel) {
        const levels = levelShown(level) ? [...hidden.value.levels, level] : hidden.value.levels.filter(l => l !== level)
        keep({...hidden.value, levels})
    }

    /** Hides a kind or a family; hiding a family takes in the kinds under it already hidden. */
    function hideKind(kind: string) {
        if (hidden.value.kinds.includes(kind)) return
        keep({...hidden.value, kinds: [...hidden.value.kinds.filter(k => !k.startsWith(`${kind}.`)), kind].sort()})
    }
    function showKind(kind: string) {
        keep({...hidden.value, kinds: hidden.value.kinds.filter(k => k !== kind)})
    }

    /** Whether it's shown: its level is on, and neither its kind nor its family is hidden. */
    const shows = (event: LoggedEvent) => levelShown(event.level)
        && !hidden.value.kinds.some(k => event.kind === k || event.kind.startsWith(`${k}.`))

    return {hidden, levelShown, toggleLevel, hideKind, showKind, shows}
}
