// A picture in Markdown (renderMarkdown links it, as do a slider's Before and After) opens larger over the page on a
// click, so a click outside it brings you back. ⌘-, ctrl-, shift- and middle-click still open it in a tab of its own.
// One listener for every picture, as they come and go with the Markdown.
export default defineNuxtPlugin(() => {
    document.addEventListener('click', (event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        const link = (event.target as Element | null)?.closest?.<HTMLAnchorElement>('a.image-link, a.compare-label')
        const src = link?.getAttribute('href')
        if (!link || !src) return
        event.preventDefault()
        const image = link.classList.contains('compare-label')
            ? link.closest('.compare')?.querySelector<HTMLImageElement>(link.classList.contains('compare-label-before') ? '.compare-before' : '.compare-after')
            : link.querySelector('img')
        useImageView().open(src, image?.alt || link.textContent || '')
    })
})
