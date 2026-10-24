export type Theme = 'system' | 'light' | 'dark'

// Light, dark, or the system's. The choice is remembered in this browser; the head script in
// nuxt.config applies it before the first paint.
export function useTheme() {
    const theme = useState<Theme>('theme', () => {
        try {
            return (localStorage.getItem('orrery-theme') as Theme | null) ?? 'system'
        } catch {
            return 'system'
        }
    })

    function apply() {
        const dark = theme.value === 'dark' || (theme.value === 'system' && !matchMedia('(prefers-color-scheme: light)').matches)
        document.documentElement.classList.toggle('dark', dark)
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

    return {theme, set, apply}
}
