import {mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'
import {pageLines, pagesLines} from '../scripts/coverage-lines.mjs'

// What the page's own code ran in the browser suite, as e2e/test.ts keeps it, told as lines of our source (ORR-784).
const original = 'const a = 1\nfunction never() { return 2 }\nconst b = 3\n'
// Served as Vite serves it: the module, with its source map at the end, a line for a line.
const map = {version: 3, sources: ['Fake.vue'], sourcesContent: [original], names: [], mappings: 'AAAA;AACA;AACA'}
const served = `${original}//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}\n`

/** A worker's record of one script, with what ran marked: all of it but `holes`. */
function reached(url: string, holes: [number, number][]) {
    const ran = new Uint8Array(served.length).fill(1)
    for (const [from, to] of holes) ran.fill(0, from, to)
    return new Map([[`${url} ${served.length}`, {url, source: served, ran}]])
}

describe("the page's coverage", () => {
    it('counts the lines that ran, of the file the dev server read, and not a function nothing called', async () => {
        const start = original.indexOf('function'), end = original.indexOf('\nconst b')
        expect(await pageLines(reached('http://localhost:3100/_nuxt/components/Fake.vue', [[start, end]]))).toEqual({'web/app/components/Fake.vue': [1, 3]})
    })

    it('leaves out a script without a source map, and files that are not ours', async () => {
        const bare = new Map([['x', {url: 'http://localhost:3100/_nuxt/components/Bare.vue', source: original, ran: new Uint8Array(original.length).fill(1)}]])
        expect(await pageLines(bare)).toEqual({})
        expect(await pageLines(reached('http://localhost:3100/_nuxt/@fs/tmp/elsewhere/Fake.vue', []))).toEqual({})
    })

    it("adds up each worker's lines", () => {
        const dir = mkdtempSync(join(tmpdir(), 'page-lines-'))
        writeFileSync(join(dir, 'page-0-1.json'), JSON.stringify({'web/app/a.ts': [3, 1], 'web/app/b.ts': [2]}))
        writeFileSync(join(dir, 'page-1-2.json'), JSON.stringify({'web/app/a.ts': [1, 5]}))
        expect(pagesLines(dir)).toEqual({'web/app/a.ts': [1, 3, 5], 'web/app/b.ts': [2]})
    })
})
