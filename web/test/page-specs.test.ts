import {readdirSync, readFileSync} from 'node:fs'
import {join, relative} from 'node:path'
import {describe, expect, it} from 'vitest'

// Every page has a browser test (ORR-730): the page walk in `navigation.spec.ts` opens it, by its list of pages or of
// old addresses, or the spec named here does.
const WEB = join(__dirname, '..')
const PAGES = join(WEB, 'app', 'pages')
const NAVIGATION = readFileSync(join(WEB, 'e2e', 'navigation.spec.ts'), 'utf8')
const ELSEWHERE: Record<string, string> = {
    // Only with login on, which the walk's orrery has off.
    'login.vue': 'e2e/login/login.spec.ts',
    // Only in development, and a page of samples rather than of the app.
    'ui.vue': 'e2e/ui-kit.spec.ts',
}

const pageFiles = (dir: string): string[] => readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? pageFiles(path) : /\.vue$/.test(entry.name) ? [relative(PAGES, path)] : []
})
/** The address a page's file serves, where `[project]` is one segment, whatever it holds. */
const address = (file: string) => new RegExp(`^/${file.replace(/\.vue$/, '').replace(/(^|\/)index$/, '').replace(/\[[^\]]+\]/g, '[^/]+')}$`)
/** Each address a spec's source names by `pattern`, with what's filled in as one segment and without its query. */
const named = (source: string, pattern: RegExp) => [...source.matchAll(pattern)].map(match => match[1]!.replace(/\$\{[^}]+\}/g, 'x').split(/[?#]/)[0]!)
const opens = (file: string, source: string, ...patterns: RegExp[]) => patterns.flatMap(pattern => named(source, pattern)).some(path => address(file).test(path))

const WALKED = /\bpath: ['`]([^'`]+)['`]/g
const REDIRECTED = /\bfrom: ['`]([^'`]+)['`]/g
const GOES_TO = /goto\(['`]([^'`]+)['`]\)/g

describe('the pages', () => {
    it('reads each page file\'s address', () => {
        expect(address('index.vue').test('/')).toBe(true)
        expect(address('mine.vue').test('/mine')).toBe(true)
        expect(address('mine.vue').test('/mine/x')).toBe(false)
        expect(address('p/[project]/issues/[issue].vue').test('/p/atlas/issues/ATL-1')).toBe(true)
        expect(address('p/[project]/index.vue').test('/p/atlas')).toBe(true)
        expect(address('p/[project]/index.vue').test('/p/atlas/roadmap')).toBe(false)
    })

    it('are each opened by the page walk, or by the spec that says why they aren\'t', () => {
        const missing = pageFiles(PAGES).filter(file => !ELSEWHERE[file] && !opens(file, NAVIGATION, WALKED, REDIRECTED))
        expect(missing).toEqual([])
    })

    it('that the walk leaves out open in their own spec', () => {
        for (const [file, spec] of Object.entries(ELSEWHERE)) {
            expect(pageFiles(PAGES), file).toContain(file)
            const source = readFileSync(join(WEB, spec), 'utf8')
            expect(opens(file, source, GOES_TO), `${spec} opens ${file}`).toBe(true)
        }
    })
})
