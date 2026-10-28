// How long each page takes to be usable on a big Orrery (seed.ts), and the API calls behind it: each step opens a
// page fresh, as a new tab or a reload does, and waits for something the owner would look for there, then for its
// calls to finish. A step over its budget fails the run, after every step has been timed. The report (report.json and
// report.md in perf-report/) lists each step, its calls by time and size, and the slowest routes over the run.
import {mkdirSync, writeFileSync} from 'node:fs'
import type {Frame, Locator, Page, Request} from '@playwright/test'
import {expect, test} from '@playwright/test'
import {hold} from '../support'
import {BIG} from './seed'

/** Milliseconds each step may take. Loose to start with; tighten them as the hot spots are fixed. */
const BUDGETS: Record<string, number> = {
    'first load': 6000,
    'project list': 5000,
    'project board': 5000,
    'project roadmap': 5000,
    'issue with a long history': 5000,
    'my issues': 5000,
    'bell': 5000,
    'notifications: inbox': 5000,
    'notifications: waiting on you': 3000,
    'notifications: cleared': 3000,
    'notifications: show older': 3000,
    'events': 5000,
    'sessions': 5000,
    'releases': 5000,
    'a release': 5000,
    'search': 3000,
    'reconnect': 8000,
    'a live change': 3000,
}

interface Call {method: string, path: string, status: number, ms: number, bytes: number}
interface Step {name: string, ms: number, budget: number, calls: Call[], pushed?: number, unfinished?: string[]}

const steps: Step[] = []

/** Times `act` until `ready` shows and the API calls it set off have finished, and keeps the step. A call the page left
 * behind when it navigated doesn't count (the browser doesn't always say it ended); one still open 15 s after `ready`
 * is noted in the report as unfinished rather than waited for. */
async function measure(page: Page, name: string, act: () => Promise<unknown>, ready: Locator) {
    const calls: Promise<Call | null>[] = []
    const pending = new Map<Request, (how: 'finished' | 'failed' | 'left') => void>()
    let last = 0
    const started = (request: Request) => {
        const url = new URL(request.url())
        if (!url.pathname.startsWith('/api/') || url.pathname === '/api/events') return
        calls.push(new Promise(resolve => pending.set(request, async how => {
            pending.delete(request)
            if (how === 'left') return resolve(null)
            last = Date.now()
            const response = how === 'failed' ? null : await request.response()
            const body = response ? await response.body().catch(() => Buffer.alloc(0)) : Buffer.alloc(0)
            const {responseEnd, responseStart} = request.timing()
            resolve({method: request.method(), path: url.pathname + url.search, status: response?.status() ?? 0,
                ms: Math.round(responseEnd > 0 ? responseEnd : responseStart), bytes: body.length})
        })))
    }
    const finished = (request: Request) => pending.get(request)?.('finished')
    const failed = (request: Request) => pending.get(request)?.('failed')
    // What's still open when the page navigates belongs to the page that's gone.
    const forget = (frame: Frame) => {
        if (frame === page.mainFrame()) for (const end of [...pending.values()]) end('left')
    }
    page.on('request', started)
    page.on('requestfinished', finished)
    page.on('requestfailed', failed)
    page.on('framenavigated', forget)
    const start = Date.now()
    let readyAt: number
    try {
        await act()
        await expect(ready).toBeVisible({timeout: 60_000})
        readyAt = Date.now()
        await expect.poll(() => pending.size, {timeout: 15_000}).toBe(0).catch(() => {})
    } finally {
        page.off('request', started)
        page.off('requestfinished', finished)
        page.off('requestfailed', failed)
        page.off('framenavigated', forget)
    }
    const unfinished = [...pending.keys()].map(r => `${r.method()} ${new URL(r.url()).pathname}`)
    pending.forEach(end => end('left'))
    const ms = Math.max(readyAt, last) - start
    const step: Step = {name, ms, budget: BUDGETS[name]!, calls: (await Promise.all(calls)).filter(c => c !== null), ...unfinished.length ? {unfinished} : {}}
    steps.push(step)
    expect.soft(ms, `${name} took ${ms} ms, over its ${step.budget} ms budget`).toBeLessThanOrEqual(step.budget)
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} kB`

function report() {
    const routes = new Map<string, {calls: number, ms: number, max: number, bytes: number}>()
    for (const call of steps.flatMap(s => s.calls)) {
        const route = `${call.method} ${call.path.replace(/\?.*/, '').replace(/\/[A-Z]+-\d+/g, '/:issue').replace(/\/\d+(\.\d+)*(?=\/|$)/g, '/:n')}`
        const seen = routes.get(route) ?? {calls: 0, ms: 0, max: 0, bytes: 0}
        routes.set(route, {calls: seen.calls + 1, ms: seen.ms + call.ms, max: Math.max(seen.max, call.ms), bytes: Math.max(seen.bytes, call.bytes)})
    }
    const slowest = [...routes].sort(([, a], [, b]) => b.max - a.max).slice(0, 15)
    const json = {
        at: new Date().toISOString(),
        database: process.env.E2E_POSTGRES_URL ? 'postgres' : 'sqlite',
        sizes: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('PERF_'))),
        steps,
        routes: Object.fromEntries(slowest),
    }
    const md = [
        `# Orrery performance, ${json.database}, ${json.at}`,
        '',
        '| Step | Time | Budget | Calls | Slowest call | Largest payload |',
        '|---|--:|--:|--:|---|---|',
        ...steps.map(s => {
            const slow = [...s.calls].sort((a, b) => b.ms - a.ms)[0]
            const big = [...s.calls].sort((a, b) => b.bytes - a.bytes)[0]
            return `| ${s.ms > s.budget ? '**over** ' : ''}${s.name} | ${s.ms} ms | ${s.budget} ms | ${s.calls.length} | ${slow ? `${slow.method} ${slow.path} (${slow.ms} ms)` : ''} | ${big ? `${big.path} (${kb(big.bytes)})` : ''} |`
        }),
        '',
        ...steps.filter(s => s.unfinished).map(s => `${s.name}: still open 15 s after it was ready, ${s.unfinished!.join(', ')}.`),
        ...steps.filter(s => s.pushed !== undefined).map(s => `${s.name}: the server pushed ${kb(s.pushed!)} to each open tab.`),
        '',
        '## Slowest routes',
        '',
        '| Route | Calls | Slowest | Average | Largest payload |',
        '|---|--:|--:|--:|--:|',
        ...slowest.map(([route, r]) => `| ${route} | ${r.calls} | ${r.max} ms | ${Math.round(r.ms / r.calls)} ms | ${kb(r.bytes)} |`),
        '',
    ].join('\n')
    mkdirSync('perf-report', {recursive: true})
    writeFileSync('perf-report/report.json', JSON.stringify(json, null, 2))
    writeFileSync('perf-report/report.md', md)
    console.log(`\n${md}`)
}

test.describe.configure({mode: 'serial'})

let page: Page
let title = ''
let sessions: {stop: () => void}[] = []

test.beforeAll(async ({browser, baseURL}) => {
    page = await browser.newPage()
    title = (await (await page.request.get(`/api/projects/${BIG.project}/issues/${BIG.issue}`)).json()).title
    const projects = (await (await page.request.get('/api/projects')).json()) as {id: string}[]
    // Sessions listening, as channels on the projects would be.
    sessions = projects.slice(0, 10).flatMap((p, i) => [0, 1].map(n =>
        hold(baseURL!, `/api/projects/${p.id}/signals/stream?session=perf-${i}-${n}&name=perf%20${i}%20${n}&format=text`)))
})

test.afterAll(async () => {
    sessions.forEach(s => s.stop())
    report()
})

test('first load', async () => {
    await measure(page, 'first load', () => page.goto('/mine'), page.getByRole('link', {name: /^Atlas \d/}).first())
})

test('a big project', async () => {
    await measure(page, 'project list', () => page.goto(`/p/${BIG.project}?view=list`), page.locator('main [data-issue]').first())
    await measure(page, 'project board', () => page.goto(`/p/${BIG.project}?view=board`), page.locator('main [data-issue]').first())
    await measure(page, 'project roadmap', () => page.goto(`/p/${BIG.project}/roadmap`), page.getByRole('main').getByRole('heading').first())
    await measure(page, 'issue with a long history', () => page.goto(`/p/${BIG.project}/issues/${BIG.issue}`), page.getByRole('heading', {name: title, level: 1}))
})

test('home and the bell', async () => {
    await measure(page, 'my issues', () => page.goto('/mine'), page.getByRole('heading', {name: 'My issues'}))
    await measure(page, 'bell', () => page.goto('/mine'), page.getByRole('link', {name: /waiting on you/}))
    await measure(page, 'notifications: inbox', () => page.goto('/notifications'), page.getByRole('main').locator('li').first())
    await measure(page, 'notifications: waiting on you', () => page.getByRole('radio', {name: /Waiting on you/}).or(page.getByRole('button', {name: /Waiting on you/})).first().click(),
        page.getByRole('main').locator('li').first())
    await measure(page, 'notifications: cleared', () => page.getByRole('radio', {name: 'Cleared'}).or(page.getByRole('button', {name: 'Cleared', exact: true})).first().click(),
        page.getByRole('button', {name: 'Show older'}))
    const shown = await page.getByRole('main').locator('li').count()
    await measure(page, 'notifications: show older', () => page.getByRole('button', {name: 'Show older'}).click(),
        page.getByRole('main').locator('li').nth(shown))
})

test('events, sessions and releases', async () => {
    await measure(page, 'events', () => page.goto('/events'), page.locator('[aria-expanded]').first())
    await measure(page, 'sessions', () => page.goto('/sessions'), page.getByText('perf 0 0').first())
    await measure(page, 'releases', () => page.goto(`/p/${BIG.project}/releases`), page.getByRole('main').getByRole('link', {name: /^1\.0\.0 /}).first())
    await measure(page, 'a release', () => page.goto(`/p/${BIG.project}/releases/1.0.0`), page.getByRole('main').locator('[data-issue]').first())
})

test('search', async () => {
    await page.goto('/mine')
    await expect(page.getByRole('link', {name: /^Atlas \d/}).first()).toBeVisible()
    await page.keyboard.press('ControlOrMeta+k')
    const box = page.getByRole('combobox', {name: 'Type a command or search'}).or(page.getByLabel('Type a command or search')).first()
    await measure(page, 'search', () => box.fill('webhook invoice'), page.getByRole('listbox', {name: 'Results'}).getByRole('option').first())
    await page.keyboard.press('Escape')
})

test('reconnecting and live changes', async () => {
    await page.goto(`/p/${BIG.project}?view=list`)
    await expect(page.locator('main [data-issue]').first()).toBeVisible()
    // The stream drops (window.stop() ends it, as a lost connection would), and opening it again loads every project
    // again. The page waits before trying again; the step is timed from when it does.
    let reconnect = () => {}
    const asked = new Promise<void>(resolve => void page.route('**/api/events', async route => {
        await new Promise<void>(go => {
            reconnect = go
            resolve()
        })
        await route.continue()
    }))
    await page.evaluate(() => window.stop())
    await asked
    await measure(page, 'reconnect', async () => {
        const reloaded = page.waitForResponse(r => r.url().includes('/api/projects?expand=board'), {timeout: 60_000})
        reconnect()
        await reloaded
    }, page.locator('main [data-issue]').first())
    await page.unroute('**/api/events')
    // An agent's change, until the open page shows it.
    // `pushed`: what the server sent each open tab for it, over the events stream.
    const stream = hold(new URL(page.url()).origin, '/api/events')
    await expect.poll(() => stream.said.text.length).toBeGreaterThan(0)
    const before = stream.said.text.length
    const renamed = `Renamed live ${Date.now()}`
    const target = await page.locator('main [data-issue]').first().getAttribute('data-issue')
    await measure(page, 'a live change', () => page.request.patch(`/api/projects/${BIG.project}/issues/${target}`, {data: {title: renamed}, headers: {'Orrery-Actor': 'claude'}}),
        page.getByText(renamed).first())
    await expect.poll(() => stream.said.text.includes(renamed)).toBe(true)
    steps.at(-1)!.pushed = Buffer.byteLength(stream.said.text.slice(before))
    stream.stop()
})
