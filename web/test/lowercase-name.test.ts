import {readFileSync, readdirSync} from 'node:fs'
import {join, relative} from 'node:path'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

// The product's name is "orrery", lowercase, wherever it's read: the page, what the server and the channel say, the
// docs and the comments new text is copied from (ORR-395). Only names that aren't prose keep a capital: the headers
// (`Orrery-Actor`, `Orrery-Session`…), and the changelog's shipped entries, left as they were written.
const root = fileURLToPath(new URL('../..', import.meta.url))
const DIRS = ['web/app', 'web/server', 'web/shared', 'web/e2e', 'web/test', 'channel', 'docs', '.github']
const FILES = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CLAUDE.md', 'web/nuxt.config.ts', 'web/public/site.webmanifest']
const TEXT = /\.(ts|mjs|js|vue|md|json|ya?ml|sh|css|html|txt|webmanifest)$/
const CAPITAL = /\bOrrery\b(?!-[A-Z])/

function files(dir: string): string[] {
    return readdirSync(join(root, dir), {withFileTypes: true}).flatMap(entry => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name.startsWith('.') && entry.name !== '.github' ? [] : files(path)
        return TEXT.test(entry.name) ? [path] : []
    })
}

describe('the name', () => {
    it('is "orrery", lowercase, everywhere it is read', () => {
        const read = [...DIRS.flatMap(files), ...FILES]
        expect(read.length).toBeGreaterThan(200)
        const capitals = read.flatMap(path => readFileSync(join(root, path), 'utf8').split('\n')
            .flatMap((line, i) => CAPITAL.test(line) && !line.includes('lowercase-name: allow') ? [`${relative(root, join(root, path))}:${i + 1}: ${line.trim()}`] : []))
        expect(capitals).toEqual([])
    })

    it("is lowercase in the changelog's entry still to ship", () => {
        const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
        const next = changelog.split(/^## /m)[1] ?? ''
        expect(next.split('\n').filter(line => CAPITAL.test(line))).toEqual([])
    })
})
