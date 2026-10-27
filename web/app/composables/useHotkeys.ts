import type {View} from './useLastView'

// The keys: j/k move between rows and cards, Enter opens, Esc closes, / searches, ⌘K jumps,
// 1/2 switch List/Board, c writes a new issue, g n goes to Now, g m to My issues. Rows take part by carrying `data-nav`.
// x ticks the focused issue for a change to many (useSelection), ⌘A ticks every one on the page, Esc clears them.
export function useHotkeys() {
    const route = useRoute()
    const router = useRouter()
    const palette = useState('palette-open', () => false)
    const sidebar = useState('sidebar-open', () => false)
    let g = 0


    function move(step: number) {
        const items = [...document.querySelectorAll<HTMLElement>('main [data-nav]')].filter(el => el.offsetParent !== null)
        if (!items.length) return
        const at = items.indexOf(document.activeElement as HTMLElement)
        const next = items[at < 0 ? (step > 0 ? 0 : items.length - 1) : Math.min(Math.max(at + step, 0), items.length - 1)]
        if (!next) return
        next.focus({preventScroll: true})
        next.scrollIntoView({block: 'nearest', inline: 'nearest'})
    }

    function onKey(event: KeyboardEvent) {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
            event.preventDefault()
            palette.value = !palette.value
            return
        }
        const selection = useSelection()
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' && !isTyping(event.target) && !palette.value && document.querySelector('main [data-issue][data-project]')) {
            event.preventDefault()
            selection.selectVisible()
            return
        }
        if (palette.value || useNewIssue().target.value || event.metaKey || event.ctrlKey || event.altKey) return
        if (event.key === 'Escape') {
            if (isTyping(event.target)) (event.target as HTMLElement).blur()
            else if (selection.selected.value.length) selection.clear()
            else if (sidebar.value) sidebar.value = false
            return
        }
        if (isTyping(event.target)) return

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
            case 'x':
            case 'X': {
                const target = document.activeElement as HTMLElement | null
                if (!target?.dataset.issue || !target.dataset.project) return
                selection.toggle(target.dataset.project, target.dataset.issue, event.shiftKey)
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
            case 'm':
                if (Date.now() - g > 1000) return
                router.push({n: '/now', m: '/mine'}[event.key])
                break
            default: return
        }
        g = 0
        event.preventDefault()
    }

    onMounted(() => window.addEventListener('keydown', onKey))
    onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
}
