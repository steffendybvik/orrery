import type {Settings} from '#shared/roadmap'
import {TINTS} from '#shared/roadmap'

// This Orrery's own settings, kept current from `/api/events`, and the tint they give the page: the
// colour goes on <html> (`data-tint`, `--tint`) for main.css to mix into the backgrounds.
export function useAppSettings() {
    const settings = useState<Settings>('app-settings', () => ({id: '', tint: null, statuses: [], focus_prompt: null, chunk_prompt: null, instructions: [], handle: null, tracker: null, starts: null}))

    /** The tint as a colour: a named one's, or the `#rrggbb` itself. */
    const tintColor = computed(() => {
        const tint = settings.value.tint
        return tint ? TINTS[tint as keyof typeof TINTS] ?? tint : null
    })

    function apply() {
        const root = document.documentElement
        if (tintColor.value) {
            root.dataset.tint = ''
            root.style.setProperty('--tint', tintColor.value)
        } else {
            delete root.dataset.tint
            root.style.removeProperty('--tint')
        }
    }

    async function save(change: Partial<Settings>) {
        settings.value = {...settings.value, ...change}
        apply()
        settings.value = await $fetch<Settings>('/api/settings', {method: 'PATCH', headers: {'Orrery-Actor': await useOwner().load()}, body: change})
    }

    return {settings, tintColor, apply, save}
}
