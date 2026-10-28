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
    const [heading, text] = /^\s*#\s+(.+)\n/.exec(source) ?? []
    const body = heading && text && text.trim().toLowerCase() === title?.trim().toLowerCase() ? source.slice(heading.length) : source
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
    compareImages(page)
    // An image orrery keeps opens larger, as a screenshot shrunk to a comment's width is hard to read: over the page
    // (plugins/image-view), or in a tab of its own on ⌘-click.
    page.querySelectorAll<HTMLImageElement>('img[src^="/api/uploads/"]').forEach(image => {
        if (image.closest('a, .compare')) return
        const link = page.createElement('a')
        link.className = 'image-link'
        link.href = image.getAttribute('src') ?? ''
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
    return {html: page.body.firstElementChild?.innerHTML ?? '', headings, changed}
}

/** Whether the node holds nothing to read: whitespace, or a line break. */
function blank(node: Node): boolean {
    return node.nodeName === 'BR' || (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim())
}

/** A picture whose alt text starts with "Before", followed by nothing but one starting with "After" (in the same
 * paragraph, or in the next one), becomes a slider between the two (`compare`): the after picture at the
 * column's full width, the before one over it up to the handle, which plugins/compare drags. Elsewhere the
 * Markdown still reads as two pictures. */
function compareImages(page: Document) {
    for (const before of [...page.querySelectorAll<HTMLImageElement>('p > img')]) {
        const paragraph = before.parentElement
        if (!paragraph || !/^before\b/i.test(before.alt)) continue
        const rest = [...paragraph.childNodes].filter(node => node !== before && !blank(node))
        // The same paragraph: the two pictures and nothing else, before first.
        let after = rest.length === 1 && rest[0] instanceof HTMLImageElement && paragraph.firstElementChild === before ? rest[0] : undefined
        let remove: Element | undefined
        // The next paragraph, the before picture alone in its own.
        if (!rest.length) {
            const next = paragraph.nextElementSibling
            const own = next?.tagName === 'P' ? [...next.childNodes].filter(node => !blank(node)) : []
            if (next && own.length === 1 && own[0] instanceof HTMLImageElement) [after, remove] = [own[0], next]
        }
        if (!after || !/^after\b/i.test(after.alt)) continue
        paragraph.replaceWith(compareOf(page, before, after))
        remove?.remove()
    }
}

function compareOf(page: Document, before: HTMLImageElement, after: HTMLImageElement): HTMLElement {
    const figure = page.createElement('figure')
    figure.className = 'compare'
    before.classList.add('compare-before')
    after.classList.add('compare-after')
    const range = page.createElement('input')
    Object.assign(range, {type: 'range', min: '0', max: '100', value: '50', className: 'compare-range'})
    range.setAttribute('aria-label', `${before.alt || 'Before'}, against ${after.alt || 'after'}`)
    const line = page.createElement('span')
    line.className = 'compare-line'
    line.setAttribute('aria-hidden', 'true')
    // The labels open each picture larger, as an image's link does.
    const labels = ([[before, 'Before'], [after, 'After']] as const).map(([image, text]) => {
        const label = page.createElement('a')
        label.className = `compare-label compare-label-${text.toLowerCase()}`
        label.href = image.getAttribute('src') ?? ''
        label.target = '_blank'
        label.rel = 'noopener'
        label.textContent = text
        return label
    })
    figure.append(after, before, line, range, ...labels)
    return figure
}
