import {describe, expect, it} from 'vitest'
import {continueList, highlightMarkdown, insertLink, toggleLines, toggleMark} from '../app/utils/markdownEdit'
import type {CodeEdit} from '../app/utils/codeBlocks'

// The edits MarkdownField's toolbar and keys make (ORR-932), shown as the text after with `|` at the cursor.
const done = (text: string, edit: CodeEdit | null) => {
    if (!edit) return null
    const after = text.slice(0, edit.from) + edit.insert + text.slice(edit.to)
    return `${after.slice(0, edit.cursor)}|${after.slice(edit.cursor)}`
}
/** The text with `[` and `]` around the selection, or `|` where the cursor is. */
const at = (marked: string) => {
    const caret = marked.indexOf('|')
    if (caret !== -1) return {text: marked.replace('|', ''), start: caret, end: caret}
    const start = marked.indexOf('[')
    const text = marked.replace('[', '').replace(']', '')
    return {text, start, end: marked.indexOf(']') - 1}
}

describe('Markdown editing', () => {
    describe('marks', () => {
        it('wraps a selection, and unwraps it again', () => {
            const {text, start, end} = at('make [this] bold')
            expect(done(text, toggleMark(text, start, end, 'bold'))).toBe('make **this**| bold')
            expect(done('make **this** bold', toggleMark('make **this** bold', 5, 13, 'bold'))).toBe('make this| bold')
            expect(done('make **this** bold', toggleMark('make **this** bold', 7, 11, 'bold'))).toBe('make this| bold')
        })

        it('puts an empty pair in with the cursor between', () => {
            expect(done('a ', toggleMark('a ', 2, 2, 'italic'))).toBe('a _|_')
            expect(done('', toggleMark('', 0, 0, 'highlight'))).toBe('==|==')
        })

        it("doesn't take bold's underscores for an italic's", () => {
            expect(done('__x__', toggleMark('__x__', 2, 3, 'italic'))).toBe('___x_|__')
        })
    })

    it('makes a link of a selection, and of an address', () => {
        expect(done('see docs', insertLink('see docs', 4, 8))).toBe('see [docs](|)')
        expect(done('https://a.b', insertLink('https://a.b', 0, 11))).toBe('[|](https://a.b)')
    })

    describe('line starts', () => {
        it('puts one on each line, numbering a list, and takes it off', () => {
            expect(done('a\nb', toggleLines('a\nb', 0, 3, 'bullets'))).toBe('- a\n- b|')
            expect(done('a\nb', toggleLines('a\nb', 0, 3, 'numbers'))).toBe('1. a\n2. b|')
            expect(done('- a\n- b', toggleLines('- a\n- b', 0, 7, 'bullets'))).toBe('a\nb|')
        })

        it('starts a list on an empty line', () => {
            expect(done('a\n', toggleLines('a\n', 2, 2, 'bullets'))).toBe('a\n- |')
        })

        it('gives way to another start', () => {
            expect(done('- a', toggleLines('- a', 1, 1, 'heading'))).toBe('## a|')
            expect(done('x\n> a', toggleLines('x\n> a', 4, 4, 'quote'))).toBe('x\na|')
        })
    })

    describe('Enter on a list', () => {
        it('starts the next item', () => {
            expect(done('- a', continueList('- a', 3))).toBe('- a\n- |')
            expect(done('  3. a', continueList('  3. a', 6))).toBe('  3. a\n  4. |')
            expect(done('- [x] a', continueList('- [x] a', 7))).toBe('- [x] a\n- [ ] |')
            expect(done('> a', continueList('> a', 3))).toBe('> a\n> |')
        })

        it('ends the list on an empty item', () => {
            expect(done('- a\n- ', continueList('- a\n- ', 6))).toBe('- a\n|')
        })

        it('leaves other lines, and code, alone', () => {
            expect(continueList('plain', 5)).toBeNull()
            expect(continueList('```\n- a', 7)).toBeNull()
        })
    })

    describe('the drawing', () => {
        const plain = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        const source = '## Head\n**b** _i_ ==h== ~~s~~ `c` [l](u) <x> & https://a.b\n- one\n> q\n```ts\n**not**\n```'

        it('keeps every character, so it lines up with the box', () => {
            expect(plain(highlightMarkdown(source))).toBe(`${source}\n`)
        })

        it('marks each kind', () => {
            const html = highlightMarkdown(source)
            for (const kind of ['heading', 'bold', 'italic', 'highlight', 'strike', 'code', 'link', 'list', 'quote', 'fence', 'codeblock']) {
                expect(html).toContain(`md-${kind}`)
            }
            expect(html).toContain('&lt;x&gt;')
            expect(html).not.toContain('md-bold">**not')
        })
    })
})
