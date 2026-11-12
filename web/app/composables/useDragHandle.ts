// A header that moves its window (the chat's, ORR-939; the floating sessions panel's, ORR-1126). A press anywhere on it
// but its controls becomes a drag once the pointer has gone a few pixels, so a click stays a click. A link in it is
// part of the grip: let go where it was pressed and it opens, dragged from and it doesn't. By mouse, pen or touch.

/** What a press on stays a click: the controls. A link isn't one, and nor is a button marked as the grip. */
const CONTROLS = 'button:not([data-grip]), input, textarea, select, [role="button"], [role="combobox"], [role="listbox"], [role="option"]'
/** How far the pointer goes before a press is a drag. */
const DRAG_FROM = 4

/** Whether a press on `target` is the control's rather than the grip's. */
export function isControl(target: EventTarget | null) {
    return !!(target as Element | null)?.closest?.(CONTROLS)
}

export function useDragHandle(options: {
    /** Whether it moves now. */
    enabled: () => boolean
    /** The window's box as the press starts. */
    rect: () => DOMRect | undefined
    /** Where the window goes: its box from the press, moved by `dx`, `dy`. */
    to: (from: DOMRect, dx: number, dy: number) => void
}) {
    const moving = ref(false)
    let pressed: {x: number, y: number, rect: DOMRect, pointer: number} | null = null
    /** Just let go of a drag: the click it ends with isn't one. */
    let dropClick = false

    // Followed on the window while pressed, not just over the header: a quick first move can leave it before it's a drag.
    function follow(on: boolean) {
        for (const [type, listener] of [['pointermove', move], ['pointerup', up], ['pointercancel', up]] as const) {
            if (on) window.addEventListener(type, listener)
            else window.removeEventListener(type, listener)
        }
    }
    function down(event: PointerEvent) {
        if (!options.enabled() || event.button !== 0 || isControl(event.target)) return
        const rect = options.rect()
        if (!rect) return
        pressed = {x: event.clientX, y: event.clientY, rect, pointer: event.pointerId}
        follow(true)
        // A link would otherwise be dragged by the browser, as a link, and the window not at all. Its click still comes.
        if ((event.target as Element).closest('a')) event.preventDefault()
    }
    function move(event: PointerEvent) {
        if (!pressed || event.pointerId !== pressed.pointer) return
        // Let go where the page didn't hear it (outside the window): no button is held any more, so it's over.
        if (!(event.buttons & 1)) return up(event)
        const dx = event.clientX - pressed.x
        const dy = event.clientY - pressed.y
        if (!moving.value) {
            if (Math.hypot(dx, dy) < DRAG_FROM) return
            moving.value = true
        }
        options.to(pressed.rect, dx, dy)
    }
    function up(event: PointerEvent) {
        if (!pressed || event.pointerId !== pressed.pointer) return
        pressed = null
        follow(false)
        if (!moving.value) return
        moving.value = false
        dropClick = true
        // The click, if one comes, is dispatched with the pointerup; anything later is a click of its own.
        setTimeout(() => { dropClick = false })
    }
    /** Bound on capture: a drag that started on a link doesn't open it when let go. */
    function click(event: MouseEvent) {
        if (!dropClick) return
        dropClick = false
        event.preventDefault()
        event.stopPropagation()
    }

    watch(moving, on => {
        document.documentElement.classList.toggle('cursor-grabbing', on)
        document.documentElement.classList.toggle('select-none', on)
    })
    onBeforeUnmount(() => {
        follow(false)
        document.documentElement.classList.remove('cursor-grabbing', 'select-none')
    })

    return {moving, down, click}
}
