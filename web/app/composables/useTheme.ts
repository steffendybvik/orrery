export type Theme = 'system' | 'light' | 'dark'

// Light, dark, or the system's (until one is picked). The choice is remembered in this browser; the head script in
// nuxt.config applies it before the first paint.
export function useTheme() {
    const theme = useState<Theme>('theme', () => {
        try {
            return (localStorage.getItem('orrery-theme') as Theme | null) ?? 'system'
        } catch {
            return 'system'
        }
    })

    /** Whether the page is dark right now, whichever way that was chosen. */
    const dark = useState('theme-dark', () => document.documentElement.classList.contains('dark'))

    function apply() {
        dark.value = theme.value === 'dark' || (theme.value === 'system' && !matchMedia('(prefers-color-scheme: light)').matches)
        document.documentElement.classList.toggle('dark', dark.value)
    }

    function set(next: Theme) {
        theme.value = next
        try {
            localStorage.setItem('orrery-theme', next)
        } catch {
            // Private windows may refuse; the choice still holds until a reload.
        }
        apply()
    }

    /** Light if it's dark now, dark if it's light. */
    function toggle() {
        set(dark.value ? 'light' : 'dark')
    }

    return {theme, dark, set, apply, toggle}
}
