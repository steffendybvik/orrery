// Right-click only does something where orrery has its own menu (issue rows and cards, chunk cards,
// schedules), which call `preventDefault` on the way up. Everywhere else the browser's menu is held back,
// except in a text field or on selected text, so copy, paste and spellcheck still work.
export default defineNuxtPlugin(() => {
    window.addEventListener('contextmenu', (event) => {
        if (event.defaultPrevented) return
        const target = event.target as HTMLElement | null
        if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return
        if (window.getSelection()?.toString().trim()) return
        event.preventDefault()
    })
})
