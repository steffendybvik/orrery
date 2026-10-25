import DOMPurify from 'dompurify'
import {marked} from 'marked'

export interface Heading {
    id: string
    text: string
    level: 2 | 3
}

/** Markdown as HTML, cleaned of anything that could run, with links to the web opening in a new tab
 * and the h2/h3 headings given ids (listed in `headings`, for a table of contents). A leading
 * `# Heading` that repeats `title` is left out, as the page already shows it. */
export function renderMarkdown(source: string, title?: string): {html: string, headings: Heading[]} {
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
    return {html: page.body.firstElementChild!.innerHTML, headings}
}
