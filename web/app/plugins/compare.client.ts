// A before/after slider in Markdown (renderMarkdown makes it from two pictures): its range moves the split,
// by drag, click or arrow keys. One listener for every slider, as they come and go with the Markdown.
export default defineNuxtPlugin(() => {
    window.addEventListener('input', (event) => {
        const range = event.target as HTMLInputElement | null
        if (!range?.classList?.contains('compare-range')) return
        range.closest<HTMLElement>('.compare')?.style.setProperty('--split', `${range.value}%`)
    })
})
