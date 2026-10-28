import type {EventLevel, LoggedEvent} from '#shared/roadmap'

// What the owner has filtered away on the Events page (ORR-379): the levels switched off. Kept per browser in
// localStorage, as when they last looked is.
const KEY = 'orrery-events-hidden'

interface Hidden {
    levels: EventLevel[]
}

export function useHiddenEvents() {
    const hidden = useState<Hidden>('events-hidden', () => {
        try {
            const kept = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Hidden>
            return {levels: Array.isArray(kept.levels) ? kept.levels : []}
        } catch {
            return {levels: []}
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
        keep({levels})
    }

    /** Whether it's shown: its level is on. */
    const shows = (event: LoggedEvent) => levelShown(event.level)

    return {levelShown, toggleLevel, shows}
}
