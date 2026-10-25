export type DocSize = 'sm' | 'md' | 'lg'

// How large a doc's text is, picked on the doc page and remembered in this browser.
export function useDocSize() {
    const size = useState<DocSize>('doc-size', () => {
        try {
            const stored = localStorage.getItem('orrery-doc-size')
            return stored === 'sm' || stored === 'lg' ? stored : 'md'
        } catch {
            return 'md'
        }
    })
    watch(size, next => {
        try {
            localStorage.setItem('orrery-doc-size', next)
        } catch {
            // Private windows may refuse; it still holds until a reload.
        }
    })
    return {size}
}
