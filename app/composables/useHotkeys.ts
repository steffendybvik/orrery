import type {View} from './useLastView'

// The keys: j/k move between rows and cards, Enter opens, Esc closes, / searches, ⌘K jumps,
// 1/2 switch Board/List, g n goes to Now, g u to Urgent. Rows take part by carrying `data-nav`.
export function useHotkeys() {
    const route = useRoute()
    const router = useRouter()
    const palette = useState('palette-open', () => false)
    const sidebar = useState('sidebar-open', () => false)
    const {issueId, close} = useIssueLink()
    let g = 0

    const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

    function move(step: number) {
        const items = [...document.querySelectorAll<HTMLElement>('main [data-nav]')].filter(el => el.offsetParent !== null)
        if (!items.length) return
        const at = items.indexOf(document.activeElement as HTMLElement)
        const next = items[at < 0 ? (step > 0 ? 0 : items.length - 1) : Math.min(Math.max(at + step, 0), items.length - 1)]!
        next.focus({preventScroll: true})
        next.scrollIntoView({block: 'nearest', inline: 'nearest'})
        // With the panel open, moving shows the next issue in it, as in Linear.
        if (issueId.value && next.dataset.issue) next.click()
    }

    function onKey(event: KeyboardEvent) {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
            event.preventDefault()
            palette.value = !palette.value
            return
        }
        if (palette.value || event.metaKey || event.ctrlKey || event.altKey) return
        if (event.key === 'Escape') {
            if (typing(event.target)) (event.target as HTMLElement).blur()
            else if (issueId.value) close()
            else if (sidebar.value) sidebar.value = false
            return
        }
        if (typing(event.target)) return

        const {view: lastView} = useLastView()
        const view = (v: View) => {
            if (route.name !== 'p-project') return
            lastView.value = v
            router.replace({query: {...route.query, view: v}})
        }
        switch (event.key) {
            case 'j': move(1); break
            case 'k': move(-1); break
            case 'Enter': {
                const target = document.activeElement as HTMLElement | null
                if (!target?.hasAttribute('data-nav')) return
                target.click()
                break
            }
            case '/': document.getElementById('search')?.focus(); break
            case '1': view('board'); break
            case '2': view('list'); break
            case 'g': g = Date.now(); return
            case 'n':
            case 'u':
                if (Date.now() - g > 1000) return
                router.push(event.key === 'n' ? '/now' : '/urgent')
                break
            default: return
        }
        g = 0
        event.preventDefault()
    }

    onMounted(() => window.addEventListener('keydown', onKey))
    onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
}
