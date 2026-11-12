// The sidebar's sessions list popped out as a panel floating over the page (ORR-901): dragged by its heading (anywhere
// on it, ORR-1126) or its grip's arrows to anywhere, and kept by the corner it's nearest to, with how far from that
// corner, so a window made smaller keeps it in sight. Remembered in this browser; back in the sidebar, it's forgotten.
// Only on a wide screen: on a narrow one the sidebar is a drawer, and a panel floating over the page would cover it.
export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
export interface FloatAt {
    corner: Corner
    x: number
    y: number
}

const KEY = 'orrery-sessions-float'
/** How close to the window's edge it may go. */
const EDGE = 8
/** Where it lands when popped out: the top right, under the page's header. */
const POPPED = {corner: 'top-right', x: 16, y: 64} as const satisfies FloatAt
/** How wide it is floating: the sidebar's width. */
const FLOAT_WIDTH = 256

const CORNERS: Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']

function load(): FloatAt | null {
    try {
        const stored = JSON.parse(localStorage.getItem(KEY) ?? 'null') as FloatAt | null
        return stored && CORNERS.includes(stored.corner) && Number.isFinite(stored.x) && Number.isFinite(stored.y) ? stored : null
    } catch {
        return null
    }
}

/** Where a panel at `left`, `top`, `width` × `height` is, by the corner of the window it's nearest to. */
export function anchored(left: number, top: number, width: number, height: number, view: {width: number, height: number}): FloatAt {
    const right = left + width / 2 > view.width / 2
    const bottom = top + height / 2 > view.height / 2
    return {
        corner: `${bottom ? 'bottom' : 'top'}-${right ? 'right' : 'left'}` as Corner,
        x: Math.round(Math.max(EDGE, right ? view.width - left - width : left)),
        y: Math.round(Math.max(EDGE, bottom ? view.height - top - height : top)),
    }
}

/** `at` kept inside the window, for a panel `width` × `height`. */
export function inView(at: FloatAt, width: number, height: number, view: {width: number, height: number}): FloatAt {
    return {
        corner: at.corner,
        x: Math.round(Math.min(Math.max(at.x, EDGE), Math.max(EDGE, view.width - width - EDGE))),
        y: Math.round(Math.min(Math.max(at.y, EDGE), Math.max(EDGE, view.height - height - EDGE))),
    }
}

export function useSessionsFloat(panel: Ref<HTMLElement | undefined>) {
    const at = useState<FloatAt | null>('sessions-float', load)
    watch(at, next => {
        try {
            if (next) localStorage.setItem(KEY, JSON.stringify(next))
            else localStorage.removeItem(KEY)
        } catch {
            // Private windows may refuse; it still holds until a reload.
        }
    }, {deep: true})

    const wide = ref(true)
    const view = reactive({width: 0, height: 0})
    let query: MediaQueryList | undefined
    const measure = () => {
        wide.value = query?.matches ?? true
        view.width = window.innerWidth
        view.height = window.innerHeight
    }
    onMounted(() => {
        query = matchMedia('(min-width: 768px)')
        measure()
        query.addEventListener('change', measure)
        window.addEventListener('resize', measure)
    })
    onBeforeUnmount(() => {
        query?.removeEventListener('change', measure)
        window.removeEventListener('resize', measure)
    })

    const floating = computed(() => !!at.value && wide.value)
    const top = computed(() => !!at.value?.corner.startsWith('top'))

    /** Its place on the page, kept in sight of the window as it is now. */
    const style = computed(() => {
        if (!floating.value || !at.value) return undefined
        const height = panel.value?.offsetHeight ?? 0
        const kept = view.width ? inView(at.value, FLOAT_WIDTH, height, view) : at.value
        const [vertical, horizontal] = kept.corner.split('-') as ['top' | 'bottom', 'left' | 'right']
        return {[vertical]: `${kept.y}px`, [horizontal]: `${kept.x}px`, width: `${FLOAT_WIDTH}px`}
    })

    /** The most it can be tall floating: the window, less where it starts. */
    const maxHeight = () => Math.max(64, window.innerHeight - (at.value?.y ?? 0) - EDGE * 2)

    // Dragged from anywhere on its heading, the Sessions link included, as the chat is by its header (ORR-1126).
    const {moving, down, click} = useDragHandle({
        enabled: () => floating.value,
        rect: () => panel.value?.getBoundingClientRect(),
        to: ({left, top, width, height}, dx, dy) => {
            at.value = inView(anchored(left + dx, top + dy, width, height, view), width, height, view)
        },
    })

    /** The grip's arrows move it, Shift by more. */
    function key(event: KeyboardEvent) {
        const step = event.shiftKey ? 64 : 16
        const by = ({ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step]} as Record<string, [number, number]>)[event.key]
        const rect = panel.value?.getBoundingClientRect()
        if (!by || !rect) return
        event.preventDefault()
        const [dx, dy] = by
        at.value = inView(anchored(rect.left + dx, rect.top + dy, rect.width, rect.height, view), rect.width, rect.height, view)
    }

    return {
        at, floating, top, style, maxHeight, moving, down, click, key,
        popOut: () => { at.value = {...POPPED} },
        dock: () => { at.value = null },
    }
}
