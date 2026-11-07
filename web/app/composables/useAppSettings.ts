import type {Settings} from '#shared/roadmap'
import {TINTS, WORK_KINDS} from '#shared/roadmap'

// This orrery's own settings, kept current from `/api/events`, and the tint they give the page: the
// colour goes on <html> (`data-tint`, `--tint`) for main.css to mix into the backgrounds.
export function useAppSettings() {
    const settings = useState<Settings>('app-settings', () => ({id: '', tint: null, statuses: [], focus_prompt: null, milestone_prompt: null, instructions: [], handle: null, uid: '', tracker: null, starts: null, terminal: 'terminal', agent: 'claude', restrict_proposals: true, advanced: true, count_use: false, work_kinds: [...WORK_KINDS], starred: [], hidden: []}))

    /** The tint as a colour: a named one's, or the `#rrggbb` itself. */
    const tintColor = computed(() => {
        const tint = settings.value.tint
        return tint ? TINTS[tint as keyof typeof TINTS] ?? tint : null
    })

    /** `next` with what only this server knows (`environment`, `database`, from `GET /api/machine`) kept: the stored
     * settings, from a save or a live update, never carry them (ORR-954). */
    function withMachine(next: Settings): Settings {
        const {environment, database} = settings.value
        return {...next, ...environment === undefined ? {} : {environment}, ...database === undefined ? {} : {database}}
    }

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

    // Saves in a row can be answered out of order, and a live update can come after the answer to a later save. Either
    // would put older settings back on screen, undoing what was typed since (ORR-519). So only the latest save's answer
    // is kept, and live updates wait while one of this tab's saves is on its way: its answer is the settings as they are.
    const saving = useState('app-settings-saving', () => 0)
    const latest = useState('app-settings-latest', () => 0)

    async function save(change: Partial<Settings>) {
        const mine = ++latest.value
        saving.value++
        settings.value = {...settings.value, ...change}
        apply()
        try {
            const saved = await apiFetch<Settings>('/settings', {method: 'PATCH', body: change})
            if (mine === latest.value) {
                settings.value = withMachine(saved)
                apply()
            }
        } finally {
            saving.value--
        }
    }

    /** The settings as a live update brings them: kept unless one of this tab's saves is on its way. */
    function heard(next: Settings) {
        if (saving.value) return
        settings.value = withMachine(next)
        apply()
    }

    return {settings, tintColor, apply, save, heard}
}
