import DOMPurify from 'dompurify'
import {marked} from 'marked'

export interface Heading {
    id: string
    text: string
    level: 2 | 3
}

/** The blocks a change is marked on: the smallest that hold text of their own. */
const BLOCKS = 'p, li, h1, h2, h3, h4, pre, blockquote, tr'

/** Each block's tag and text, as a change is told by. */
function blocksOf(root: ParentNode): {element: Element, key: string}[] {
    return [...root.querySelectorAll(BLOCKS)]
        .filter(element => !element.querySelector(BLOCKS))
        .map(element => ({element, key: `${element.tagName}:${element.textContent?.replace(/\s+/g, ' ').trim()}`}))
}

/** Markdown as HTML, cleaned of anything that could run, with links to the web opening in a new tab
 * and the h2/h3 headings given ids (listed in `headings`, for a table of contents). A leading
 * `# Heading` that repeats `title` is left out, as the page already shows it. Given `before` (the
 * Markdown as last read), each block that's new or different since gets the `changed` class; `changed`
 * counts them. */
export function renderMarkdown(source: string, title?: string, before?: string): {html: string, headings: Heading[], changed: number} {
    const first = /^\s*#\s+(.+)\n/.exec(source)
    const body = first && first[1]!.trim().toLowerCase() === title?.trim().toLowerCase() ? source.slice(first[0].length) : source
    const clean = DOMPurify.sanitize(marked.parse(body, {async: false, gfm: true}), {USE_PROFILES: {html: true}})

    const page = new DOMParser().parseFromString(`<div>${clean}</div>`, 'text/html')
    const headings: Heading[] = []
    const taken = new Set<string>()
    page.querySelectorAll('h2, h3').forEach(element => {
        const text = element.textContent?.trim() ?? ''
        // `h-` keeps an id from ever naming something on the page itself (DOM clobbering).
        const base = `h-${text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section'}`
        let id = base
        for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
        taken.add(id)
        element.id = id
        headings.push({id, text, level: element.tagName === 'H2' ? 2 : 3})
    })
    page.querySelectorAll<HTMLAnchorElement>('a[href^="http://"], a[href^="https://"]').forEach(link => {
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
    })
    // An image Orrery keeps opens at full size, as a screenshot shrunk to a comment's width is hard to read.
    page.querySelectorAll<HTMLImageElement>('img[src^="/api/uploads/"]').forEach(image => {
        if (image.closest('a')) return
        const link = page.createElement('a')
        link.href = image.getAttribute('src')!
        link.target = '_blank'
        link.rel = 'noopener'
        image.replaceWith(link)
        link.append(image)
    })
    let changed = 0
    if (before !== undefined && before !== source) {
        const old = new DOMParser().parseFromString(`<div>${renderMarkdown(before, title).html}</div>`, 'text/html')
        const left = new Map<string, number>()
        for (const {key} of blocksOf(old)) left.set(key, (left.get(key) ?? 0) + 1)
        for (const {element, key} of blocksOf(page)) {
            const n = left.get(key) ?? 0
            if (n) left.set(key, n - 1)
            else {
                element.classList.add('changed')
                changed++
            }
        }
    }
    return {html: page.body.firstElementChild!.innerHTML, headings, changed}
}
