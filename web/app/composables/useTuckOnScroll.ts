/** How far a page has to scroll down at once before the button tucks away, so a nudge or a bounce doesn't. */
const TUCK_PX = 8
/** Within this of a box's end, the button is back: the end of every page has room for it (`clear-agent`). */
const END_PX = 4

/**
 * Whether a phone's Agent button is tucked away (ORR-1282). On a phone it sits over the right of each row, where its
 * assignee and status are, all the way down a list: scrolling the page down tucks it away, and scrolling back up, or
 * to the end of the page, where `clear-agent` leaves room for it, brings it back. Only scrolling in the page (`#main`)
 * counts, and only below `sm`; a wider screen has the room beside a row's end.
 */
export function useTuckOnScroll() {
    const tucked = ref(false)
    const seen = new WeakMap<Element, number>()
    let phone: MediaQueryList | undefined
    function scrolled(event: Event) {
        const box = event.target
        if (!(box instanceof Element) || !phone?.matches || !box.closest('#main')) return
        const top = box.scrollTop
        const before = seen.get(box) ?? 0
        seen.set(box, top)
        if (box.scrollHeight - box.clientHeight - top <= END_PX) tucked.value = false
        else if (top - before > TUCK_PX) tucked.value = true
        else if (top < before) tucked.value = false
    }
    const unphone = () => {
        if (!phone?.matches) tucked.value = false
    }
    onMounted(() => {
        phone = matchMedia('(max-width: 639px)')
        phone.addEventListener('change', unphone)
        // A scroll doesn't bubble, so the page's boxes are heard as it goes down to them.
        document.addEventListener('scroll', scrolled, {capture: true, passive: true})
    })
    onBeforeUnmount(() => {
        phone?.removeEventListener('change', unphone)
        document.removeEventListener('scroll', scrolled, {capture: true})
    })
    // Another page starts with it out.
    watch(() => useRoute().path, () => tucked.value = false)
    return tucked
}
