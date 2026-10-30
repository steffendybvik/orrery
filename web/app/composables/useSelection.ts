// The issues ticked for a change to many at once (BulkBar), as `project/id` keys. A shift-click ticks the run
// from the last one ticked (`anchor`), over the rows and cards on the page in their order (`data-issue`,
// `data-project`); pressing a tick and dragging over others sets each the way the first went, and a group's tick
// (GroupTick) sets all its rows. Esc or leaving the page clears it.
export function useSelection() {
    const selected = useState<string[]>('selection', () => [])
    const anchor = useState<string | null>('selection-anchor', () => null)
    const key = (project: string, id: string) => `${project}/${id}`

    const isSelected = (project: string, id: string) => selected.value.includes(key(project, id))

    /** The issues on the page, in order, once each (a sub-issue's row counts as its own). */
    function visible(): string[] {
        const els = [...document.querySelectorAll<HTMLElement>('main [data-issue][data-project]')].filter(el => el.offsetParent !== null)
        return [...new Set(els.flatMap(el => {
            const {project, issue} = el.dataset
            return project && issue ? [key(project, issue)] : []
        }))]
    }

    function toggle(project: string, id: string, range = false) {
        const k = key(project, id)
        if (range && anchor.value && anchor.value !== k) {
            const all = visible()
            const [a, b] = [all.indexOf(anchor.value), all.indexOf(k)]
            if (a >= 0 && b >= 0) {
                selected.value = [...new Set([...selected.value, ...all.slice(Math.min(a, b), Math.max(a, b) + 1)])]
                anchor.value = k
                return
            }
        }
        selected.value = selected.value.includes(k) ? selected.value.filter(s => s !== k) : [...selected.value, k]
        anchor.value = k
    }

    /** Ticks the issues (keys), or unticks them. */
    function set(keys: string[], on: boolean) {
        const rest = selected.value.filter(k => !keys.includes(k))
        selected.value = on ? [...rest, ...keys] : rest
    }

    /** A press on a tick: ticks it, or unticks it, and so each row or card the mouse then drags over, until it's let go.
     *  The click the press ends in is eaten, so it neither ticks twice nor opens the issue it's let go on. */
    function drag(event: PointerEvent, project: string, id: string) {
        if (event.button !== 0 || event.shiftKey || event.pointerType === 'touch') return
        event.preventDefault()
        toggle(project, id)
        const on = isSelected(project, id)
        const over = (e: PointerEvent) => {
            // Let go outside the window, where no pointerup reaches it: the drag is over, and a move back ticks nothing.
            if (!(e.buttons & 1)) return stop()
            const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('main [data-issue][data-project]')
            const {project: p, issue} = el?.dataset ?? {}
            if (p && issue && isSelected(p, issue) !== on) set([key(p, issue)], on)
        }
        const eat = (e: MouseEvent) => (e.stopPropagation(), e.preventDefault())
        const stop = () => {
            window.removeEventListener('pointermove', over)
            window.removeEventListener('pointerup', end)
            window.removeEventListener('pointercancel', end)
        }
        const end = () => {
            stop()
            window.addEventListener('click', eat, {capture: true})
            setTimeout(() => window.removeEventListener('click', eat, {capture: true}))
        }
        window.addEventListener('pointermove', over)
        window.addEventListener('pointerup', end)
        window.addEventListener('pointercancel', end)
    }

    /** The ticked ones in the order the page lists them, top to bottom (as the bar's Chain in order links them); any
     *  not on the page after, in the order they were ticked. */
    function inPageOrder(): string[] {
        const all = visible()
        const at = (k: string) => {
            const i = all.indexOf(k)
            return i < 0 ? all.length : i
        }
        return [...selected.value].sort((a, b) => at(a) - at(b))
    }

    function selectVisible() {
        selected.value = [...new Set([...selected.value, ...visible()])]
    }

    function clear() {
        selected.value = []
        anchor.value = null
    }

    /** The ticked issues by project, as each project's bulk call takes them. */
    const byProject = computed(() => {
        const out = new Map<string, string[]>()
        for (const k of selected.value) {
            const at = k.indexOf('/')
            const project = k.slice(0, at)
            out.set(project, [...out.get(project) ?? [], k.slice(at + 1)])
        }
        return out
    })

    return {selected, key, isSelected, toggle, set, drag, selectVisible, inPageOrder, clear, byProject}
}
