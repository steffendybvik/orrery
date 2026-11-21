import {describe, expect, it} from 'vitest'
import {renderMarkdown} from '~/utils/markdown'

// renderMarkdown: what an issue, a doc or a comment shows of its Markdown, with its headings listed, pictures from
// another site not loaded (ORR-751), and what changed since last read marked.
//
// What DOMPurify cleans is for e2e/markdown.spec.ts, in a real browser: under happy-dom it strips nothing (a
// <script>, an onerror and a javascript: link all stay) and unwraps the first element it's given. So these tests
// check only what orrery does after it, and each source starts with a paragraph (LEAD) for that first element.
const LEAD = 'Lead.\n\n'
type Rest = Parameters<typeof renderMarkdown> extends [string, ...infer R] ? R : never
const html = (source: string, ...rest: Rest) => renderMarkdown(LEAD + source, ...rest).html
const dom = (source: string, ...rest: Rest) => {
    const div = document.createElement('div')
    div.innerHTML = html(source, ...rest)
    return div
}

describe('renderMarkdown', () => {
    it('highlights ==text==, and leaves a lone or spaced == as it is', () => {
        expect(html('a ==bright **bold**== word')).toContain('<mark>bright <strong>bold</strong></mark>')
        expect(html('a == b == c')).not.toContain('<mark>')
        expect(html('x ==y=== z')).not.toContain('<mark>y</mark>')
    })

    it('leaves out a leading # heading that repeats the title, and keeps one that differs', () => {
        // Not through LEAD: the heading has to come first.
        expect(renderMarkdown('# Shelves\n\nBody', 'shelves ').html).not.toContain('Shelves')
        expect(renderMarkdown('# Kitchen\n\nBody', 'Shelves').html).toContain('Kitchen')
        const kept = dom('# Kitchen\n\nBody', 'Shelves')
        expect(kept.querySelector('h1')).toBeNull()
        expect(kept.querySelector('h2[data-h1]')?.textContent).toBe('Kitchen')
    })

    it('gives h2 and h3 headings ids for a table of contents, unique and prefixed', () => {
        const {headings, html: out} = renderMarkdown(LEAD + '## Oak & Pine\n\n### Oak & Pine\n\n## !!!\n\n#### Deep')
        expect(headings).toEqual([
            {id: 'h-oak-pine', text: 'Oak & Pine', level: 2},
            {id: 'h-oak-pine-2', text: 'Oak & Pine', level: 3},
            {id: 'h-section', text: '!!!', level: 2},
        ])
        expect(out).toContain('id="h-oak-pine-2"')
    })

    it('drops an input that is not a task list checkbox, and keeps the checkbox', () => {
        const out = dom('- [x] done\n\nYour key: <input name="key">')
        expect(out.querySelector('input:not([type="checkbox"])')).toBeNull()
        expect(out.querySelector('input[type="checkbox"]')).not.toBeNull()
    })

    it('lets a keyboard scroll a code block or a table', () => {
        const out = dom('```\ncode\n```\n\n| a |\n|---|\n| b |')
        expect(out.querySelector('pre')?.getAttribute('tabindex')).toBe('0')
        expect(out.querySelector('pre')?.getAttribute('aria-label')).toBe('Code')
        expect(out.querySelector('table')?.getAttribute('aria-label')).toBe('Table')
    })

    it('opens a link to another site in a new tab, and one of its own only with newTab', () => {
        const away = dom('[site](https://example.com) [home](/mine) [proto](//example.com)')
        const [site, home] = [...away.querySelectorAll('a')]
        expect(site!.target).toBe('_blank')
        expect(site!.rel).toBe('noopener noreferrer')
        expect(home!.getAttribute('target')).toBeNull()
        const own = dom('[home](/mine) [proto](//example.com)', undefined, undefined, {newTab: true})
        const [mine, proto] = [...own.querySelectorAll('a')]
        expect(mine!.target).toBe('_blank')
        expect(mine!.rel).toBe('noopener')
        expect(proto!.getAttribute('target')).toBeNull()
    })

    it("doesn't load a picture from another site: it's a link naming the site, or words inside a link", () => {
        const out = dom('![a cat](https://cats.example/cat.png)\n\n[![](https://cats.example/x.png)](https://cats.example)\n\n![data](data:image/png;base64,AAAA)')
        const imgs = [...out.querySelectorAll('img')]
        expect(imgs.map(i => i.getAttribute('src'))).toEqual(['data:image/png;base64,AAAA'])
        const links = [...out.querySelectorAll('a')]
        expect(links[0]!.textContent).toBe('a cat (cats.example)')
        expect(links[0]!.getAttribute('href')).toBe('https://cats.example/cat.png')
        expect(links[1]!.textContent).toBe('Image (cats.example)')
    })

    it("shows a picture whose address isn't http as its words alone", () => {
        const out = dom('![odd](ftp://files.example/x.png)')
        expect(out.querySelector('img, a')).toBeNull()
        expect(out.textContent).toContain('odd (files.example)')
    })

    it('wraps an uploaded picture in a link that opens it larger, unless it is in a link already', () => {
        const src = apiUrl('/uploads/shot.png')
        const out = dom(`![shot](${src})\n\n[![linked](${src})](/elsewhere)`)
        const wrapped = out.querySelector('a.image-link')
        expect(wrapped?.getAttribute('href')).toBe(src)
        expect(wrapped?.querySelector('img')?.alt).toBe('shot')
        expect(out.querySelectorAll('a.image-link')).toHaveLength(1)
    })

    it('makes a Before then After pair a slider, in one paragraph or the next', () => {
        const before = apiUrl('/uploads/before.png')
        const after = apiUrl('/uploads/after.png')
        for (const source of [`![Before: old](${before}) ![After: new](${after})`, `![Before](${before})\n\n![After](${after})`]) {
            const out = dom(source)
            const figure = out.querySelector('figure.compare')
            expect(figure, source).not.toBeNull()
            expect(figure!.querySelector('img.compare-after')?.getAttribute('src')).toBe(after)
            expect(figure!.querySelector('img.compare-before')?.getAttribute('src')).toBe(before)
            expect(figure!.querySelector('input.compare-range')?.getAttribute('aria-label')).toMatch(/^Before.*, against After/)
            expect([...figure!.querySelectorAll('a.compare-label')].map(a => a.textContent)).toEqual(['Before', 'After'])
            expect(out.querySelectorAll('img')).toHaveLength(2)
        }
    })

    it('leaves two pictures as they are when they are not a Before and After pair', () => {
        const a = apiUrl('/uploads/a.png')
        for (const source of [`![After](${a}) ![Before](${a})`, `![Before](${a}) and words ![After](${a})`, `![Before](${a})\n\n![Later](${a})`, `![Before](${a})\n\nwords`]) {
            expect(dom(source).querySelector('figure.compare'), source).toBeNull()
        }
    })

    it('marks each block new or changed since it was last read, and counts them', () => {
        const before = '## Plan\n\nOne\n\nTwo\n\n- a\n- b'
        const now = '## Plan\n\nOne\n\nTwo, changed\n\n- a\n- b\n- c'
        const {changed, html: out} = renderMarkdown(LEAD + now, undefined, LEAD + before)
        expect(changed).toBe(2)
        const div = document.createElement('div')
        div.innerHTML = out
        expect([...div.querySelectorAll('.changed')].map(e => e.textContent)).toEqual(['Two, changed', 'c'])
        expect(renderMarkdown(LEAD + now, undefined, LEAD + now).changed).toBe(0)
        expect(renderMarkdown(LEAD + now).changed).toBe(0)
    })

    it('counts a repeated block once for each time it is new', () => {
        expect(renderMarkdown(LEAD + 'x\n\nx\n\nx', undefined, LEAD + 'x').changed).toBe(2)
    })
})
