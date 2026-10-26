import type {Ref} from 'vue'

// Closes something open (a menu, a picker) when you press outside `element`, and, if asked, when the window loses
// focus or resizes. It listens only while `isOpen`, and stops when the component goes. `capture` hears the press
// before anything under it does, as a right-click menu needs.
export function useDismiss(element: Ref<HTMLElement | null | undefined>, isOpen: () => unknown, close: () => void,
    {capture = false, blur = false, resize = false} = {}) {
    const outside = (event: PointerEvent) => {
        if (!element.value?.contains(event.target as Node)) close()
    }
    function listen(on: boolean) {
        const method = on ? 'addEventListener' : 'removeEventListener'
        document[method]('pointerdown', outside as EventListener, capture)
        if (blur) window[method]('blur', close)
        if (resize) window[method]('resize', close)
    }
    watch(() => !!isOpen(), listen)
    onBeforeUnmount(() => listen(false))
}
