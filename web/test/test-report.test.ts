import {describe, expect, it} from 'vitest'
import {coverageNumbers, e2eNumbers, notCompared, page, runsIn, unitNumbers, withRun} from '../scripts/test-report.mjs'

// The Test speed and coverage artifact (ORR-678): what it reads from a run's results, and the versions it carries.
const test = (fullName: string, duration: number) => ({fullName, duration})
const vitest = {
    startTime: 1000, numTotalTests: 3, numFailedTests: 1, numPendingTests: 1, numTodoTests: 0,
    testResults: [
        {name: '/ci/repo/web/test/a.test.ts', startTime: 1000, endTime: 3000, assertionResults: [test('a one', 1500), test('a two', 100)]},
        {name: '/ci/repo/web/test/b.test.ts', startTime: 1000, endTime: 6000, assertionResults: [test('b one', 4000)]},
    ],
}
const spec = (title: string, ...durations: number[]) => ({title, tests: [{results: durations.map(duration => ({duration}))}]})
const playwright = {
    stats: {duration: 90_000, unexpected: 1, flaky: 1, skipped: 2},
    suites: [
        {file: 'a.spec.ts', specs: [spec('quick', 1000)], suites: [{file: 'a.spec.ts', specs: [spec('nested', 2000, 3000)]}]},
        {file: 'b.spec.ts', specs: [spec('slow', 20_000)]},
    ],
}
const numbers = (pct: number, covered: number, total: number) => ({pct, covered, total})
const file = (pct: number, covered: number, total: number) => ({lines: numbers(pct, covered, total), branches: numbers(pct, covered, total), functions: numbers(pct, covered, total), statements: numbers(pct, covered, total)})
const coverage = {
    total: file(70, 70, 100),
    '/ci/repo/web/server/api/a.get.ts': file(0, 0, 10),
    '/ci/repo/web/server/api/b.get.ts': file(100, 40, 40),
    '/ci/repo/channel/tools.mjs': file(0, 0, 50),
}

describe('reading a run', () => {
    it('takes the wall clock and the slowest of Vitest\'s', () => {
        const unit = unitNumbers(vitest)
        expect(unit).toMatchObject({seconds: 5, tests: 3, failed: 1, skipped: 1})
        expect(unit.files[0]).toEqual({name: 'web/test/b.test.ts', seconds: 5, tests: 1})
        expect(unit.slowest.map((t: {name: string}) => t.name)).toEqual(['b one', 'a one', 'a two'])
    })

    it('takes Playwright\'s, nested suites and every retry included', () => {
        const e2e = e2eNumbers(playwright)
        expect(e2e).toMatchObject({seconds: 90, tests: 3, failed: 2, skipped: 2})
        expect(e2e.slowest[1]).toEqual({name: 'nested', file: 'e2e/a.spec.ts', seconds: 5})
        expect(e2e.files).toEqual([{name: 'e2e/b.spec.ts', seconds: 20, tests: 1}, {name: 'e2e/a.spec.ts', seconds: 6, tests: 2}])
    })

    it('takes the coverage by area, with what no test runs and the least covered, largest first', () => {
        const summary = coverageNumbers(coverage)
        expect(summary.lines).toBe(70)
        expect(summary.areas.find((a: {area: string}) => a.area === 'server/api')).toEqual({area: 'server/api', files: 2, untested: 1, lines: 80, branches: 80})
        expect(summary.areas.find((a: {area: string}) => a.area === 'shared')).toEqual({area: 'shared', files: 0, untested: 0, lines: null, branches: null})
        expect(summary.least.map((f: {file: string}) => f.file)).toEqual(['channel/tools.mjs', 'web/server/api/a.get.ts', 'web/server/api/b.get.ts'])
    })
})

describe('comparing two versions', () => {
    const count = (r: {e2e: {failed: number}}) => r.e2e
    const setup = (r: {e2e: {setup?: {workers?: number, server?: string}}}) => r.e2e.setup
    const run = (failed = 0, setup?: {workers?: number, server?: string}, source = 'ci') => ({source, e2e: {failed, setup}})

    it('sets two runs of the same kind side by side', () => {
        expect(notCompared(run(0, {workers: 1, server: 'dev'}), run(), count, setup)).toBeNull()
    })

    it('doesn\'t compare a local run with one on CI', () => {
        expect(notCompared(run(), run(0, undefined, 'local'), count, setup)).toBe('one is local, one on CI')
    })

    it('doesn\'t compare a run in which tests failed', () => {
        expect(notCompared(run(1), run(), count, setup)).toMatch(/^tests failed/)
        expect(notCompared(run(), run(2), count, setup)).toMatch(/^tests failed/)
    })

    it('doesn\'t take a change to how the suite runs for a speedup, and a run from before it was kept as one worker on dev', () => {
        expect(notCompared(run(0, {workers: 4, server: 'dev'}), run(), count, setup)).toBe('one ran 4 workers on dev, the other 1 worker on dev')
        expect(notCompared(run(0, {workers: 1, server: 'built'}), run(), count, setup)).toBe('one ran 1 worker on built, the other 1 worker on dev')
    })

    it('leaves out the setup for a suite that has none', () => {
        expect(notCompared(run(0, {workers: 4}), run(), count, undefined)).toBeNull()
    })

    it('keeps what Playwright says about how it ran', () => {
        const ran = {...playwright, config: {workers: 2, metadata: {actualWorkers: 4, server: 'built'}}}
        expect(e2eNumbers(ran).setup).toEqual({workers: 4, server: 'built'})
        expect(e2eNumbers(playwright).setup).toBeUndefined()
    })

    it('puts the same check in the page\'s own script', () => {
        expect(page([])).toContain('const notCompared = function notCompared(')
    })
})

describe('the versions', () => {
    const run = (version: string, name = 'a') => ({version, name})

    it('replaces a version\'s numbers on a second run, and adds a new version last', () => {
        const runs = [run('1'), run('2')]
        expect(withRun(runs, run('1', 'b'))).toEqual([run('1', 'b'), run('2')])
        expect(withRun(runs, run('3'))).toEqual([...runs, run('3')])
    })

    it('carries them through the page', () => {
        const runs = [run('1.0.0-rc.15', 'has </script><img src=x> in it')]
        const html = page(runs)
        expect(html).not.toContain('</script><img')
        expect(runsIn(html)).toEqual(runs)
    })

    it('starts afresh from a doc that holds none', () => {
        for (const html of [undefined, '', '<p>Hello</p>']) expect(runsIn(html)).toEqual([])
    })

    it('stops rather than write over numbers it can\'t read', () => {
        for (const html of ['<script type="application/json" id="runs">{broken</script>', '<script type="application/json" id="runs">{}</script>']) expect(() => runsIn(html)).toThrow("can't be read")
    })
})
