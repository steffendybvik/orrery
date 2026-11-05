import {mkdirSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {type Page, expect, test as base} from '@playwright/test'
import {pageLines} from '../scripts/coverage-lines.mjs'

// `test` and `expect` for every spec: Playwright's own, plus, with E2E_PAGE_COVERAGE=<dir>, what the page's code ran in
// Chrome (ORR-784). Each worker keeps which parts of the page's scripts ran over all its tests, and writes the lines of the
// source they come to once its tests are done, for `coverage-lines.mjs --pages <dir>` to add up. Without it, nothing changes.
const dir = process.env.E2E_PAGE_COVERAGE

/** Each of the page's own scripts that ran, by its address and length, with a mark on each character some test ran. */
type Reached = Map<string, {url: string, source: string, ran: Uint8Array}>
type Script = Awaited<ReturnType<Page['coverage']['stopJSCoverage']>>[number]

// The page's own modules as the dev server serves them: not a dependency, Vite's client, a virtual module or styles.
const OURS = /^\/_nuxt\/(?!@vite\/|@id\/)(?!.*\/node_modules\/)(?!.*\.css$)/

/** Adds what one page ran to what the worker has seen. V8's ranges nest, each inside the one before it that holds it,
 * so taking them outermost first leaves each character with the count of the innermost range around it. */
function reach(reached: Reached, scripts: Script[]) {
    for (const {url, source, functions} of scripts) {
        const {pathname, search} = new URL(url)
        if (!source || !OURS.test(pathname) || search.includes('type=style')) continue
        const key = `${url} ${source.length}`
        const seen = reached.get(key) ?? {url, source, ran: new Uint8Array(source.length)}
        reached.set(key, seen)
        const ranges = functions.flatMap(f => f.ranges).sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset)
        const now = new Uint8Array(source.length)
        for (const range of ranges) now.fill(range.count ? 1 : 0, range.startOffset, range.endOffset)
        for (let at = 0; at < now.length; at++) seen.ran[at] |= now[at]!
    }
}

export const test = base.extend<{pageCoverage: undefined}, {reached: Reached | undefined}>({
    // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's needs from its first argument's pattern.
    reached: [async ({}, use, worker) => {
        if (!dir) return use(undefined)
        const reached: Reached = new Map()
        await use(reached)
        mkdirSync(dir, {recursive: true})
        writeFileSync(join(dir, `page-${worker.workerIndex}-${process.pid}.json`), JSON.stringify(await pageLines(reached)))
    }, {scope: 'worker', auto: true}],
    // Every page the test opens in its context, from its first script, as long as it's still open at the end.
    pageCoverage: [async ({context, reached, browserName}, use) => {
        if (!reached || browserName !== 'chromium') return use(undefined)
        const started = new Set<Page>()
        const start = (page: Page) => {
            started.add(page)
            return page.coverage.startJSCoverage({resetOnNavigation: false}).catch(() => {})
        }
        context.on('page', start)
        await Promise.all(context.pages().map(start))
        await use(undefined)
        for (const page of started) {
            if (!page.isClosed()) reach(reached, await page.coverage.stopJSCoverage().catch(() => []))
        }
    }, {auto: true}],
})

export {expect}
