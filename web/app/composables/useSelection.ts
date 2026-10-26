// The issues ticked for a change to many at once (BulkBar), as `project/id` keys. A shift-click ticks the run
// from the last one ticked (`anchor`), over the rows and cards on the page in their order (`data-issue`,
// `data-project`). Esc or leaving the page clears it.
export function useSelection() {
    const selected = useState<string[]>('selection', () => [])
    const anchor = useState<string | null>('selection-anchor', () => null)
    const key = (project: string, id: string) => `${project}/${id}`

    const isSelected = (project: string, id: string) => selected.value.includes(key(project, id))

    /** The issues on the page, in order, once each (a sub-issue's row counts as its own). */
    function visible(): string[] {
        const els = [...document.querySelectorAll<HTMLElement>('main [data-issue][data-project]')].filter(el => el.offsetParent !== null)
        return [...new Set(els.map(el => key(el.dataset.project!, el.dataset.issue!)))]
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

    return {selected, isSelected, toggle, selectVisible, clear, byProject}
}
