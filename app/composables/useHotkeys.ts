import type {View} from './useLastView'

// The keys: j/k move between rows and cards, Enter opens, Esc closes, / searches, ⌘K jumps,
// 1/2 switch List/Board, c writes a new issue, g n goes to Now, g u to Urgent. Rows take part by carrying `data-nav`.
export function useHotkeys() {
    const route = useRoute()
    const router = useRouter()
    const palette = useState('palette-open', () => false)
    const sidebar = useState('sidebar-open', () => false)
    let g = 0

    const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

    function move(step: number) {
        const items = [...document.querySelectorAll<HTMLElement>('main [data-nav]')].filter(el => el.offsetParent !== null)
        if (!items.length) return
        const at = items.indexOf(document.activeElement as HTMLElement)
        const next = items[at < 0 ? (step > 0 ? 0 : items.length - 1) : Math.min(Math.max(at + step, 0), items.length - 1)]!
        next.focus({preventScroll: true})
        next.scrollIntoView({block: 'nearest', inline: 'nearest'})
    }

    function onKey(event: KeyboardEvent) {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
            event.preventDefault()
            palette.value = !palette.value
            return
        }
        if (palette.value || useNewIssue().target.value || event.metaKey || event.ctrlKey || event.altKey) return
        if (event.key === 'Escape') {
            if (typing(event.target)) (event.target as HTMLElement).blur()
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
        // An issue's page has j/k (next and previous issue) and Esc of its own.
        const onIssue = route.name === 'p-project-issues-issue'
        switch (event.key) {
            case 'j': if (onIssue) return; move(1); break
            case 'k': if (onIssue) return; move(-1); break
            case 'Enter': {
                const target = document.activeElement as HTMLElement | null
                if (!target?.hasAttribute('data-nav')) return
                target.click()
                break
            }
            case '/': document.getElementById('search')?.focus(); break
            case 'c': {
                const project = route.params.project as string | undefined
                if (!project) return
                const chunk = route.name === 'p-project-roadmap-chunk' && route.params.chunk !== 'none' ? String(route.params.chunk) : undefined
                useNewIssue().open(project, chunk)
                break
            }
            case '1': view('list'); break
            case '2': view('board'); break
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
