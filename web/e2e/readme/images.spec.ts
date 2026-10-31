import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import type {Page} from '@playwright/test'
import {expect, test} from '@playwright/test'
import {hold} from '../support'

// Takes the README's images, into docs/images: not a test, and not part of `pnpm test:e2e`. The playground's demo,
// schedules for its page, and a fake launcher and three fake sessions where Claude would be: one waiting on a
// permission, one working an issue and one idle.
test.describe.configure({mode: 'serial'})

const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url))
const SESSIONS = [
    {id: 'readme-gerd', project: 'graphs', name: 'Gerd', cwd: '/code/graphs', event: 'Notification', message: 'Claude needs your permission to use Bash'},
    {id: 'readme-nordre', project: 'primes', name: 'Nordre', cwd: '/code/primes', event: 'UserPromptSubmit'},
    {id: 'readme-siv', project: 'primes-cli', name: 'Siv', cwd: '/code/primes', event: 'SessionStart'},
]
const VERSION = JSON.parse(readFileSync(repo('web/package.json'), 'utf8')).version
const OWNER = {'Orrery-Actor': 'skoll'}
let streams: ReturnType<typeof hold>[] = []

test.beforeAll(async ({request, baseURL}) => {
    execFileSync('node', [repo('.playground/seed.mjs'), baseURL!])
    // Its repo is made up, so the issue's page would say GitHub doesn't have it.
    expect((await request.patch('/api/projects/primes', {data: {repo: null}, headers: OWNER})).ok()).toBeTruthy()
    streams = [
        hold(baseURL!, `/api/projects/primes/launches/stream?version=${VERSION}`),
        ...SESSIONS.map(s => hold(baseURL!, `/api/projects/${s.project}/signals/stream?session=${s.id}&name=${s.name}&version=${VERSION}&format=text`)),
    ]
    await expect.poll(async () => (await (await request.get('/api/sessions')).json()).filter((s: {listening: boolean}) => s.listening).length).toBe(SESSIONS.length)
    const focus = await request.post('/api/projects/primes/issues/PRM-3/focus', {data: {session: 'readme-nordre'}, headers: OWNER})
    expect(focus.ok(), await focus.text()).toBeTruthy()
    for (const session of SESSIONS) expect((await request.post('/api/sessions', {data: session})).ok()).toBeTruthy()
})

test.afterAll(() => {
    for (const stream of streams) stream.stop()
})

/** Opens the page, its permission popup hidden as it would cover the page, and waits for it to settle. */
async function open(page: Page, path: string) {
    await page.goto(path)
    await page.getByRole('alertdialog', {name: 'Gerd needs permission'}).getByRole('button', {name: 'Hide until it asks again'}).click()
}

async function shoot(page: Page, name: string) {
    await page.mouse.move(0, 0)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))))
    await page.screenshot({path: repo(`docs/images/${name}-light.png`)})
}

test('board', async ({page}) => {
    await open(page, '/p/primes?view=board')
    await expect(page.getByRole('heading', {name: 'In progress'})).toBeVisible()
    // All five columns don't fit this wide, so the ones that say most.
    await page.getByRole('button', {name: /^Column/}).click()
    for (const name of ['In review', 'Backlog']) await page.getByRole('option', {name}).click()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', {name: 'Backlog'})).toHaveCount(0)
    await shoot(page, 'board')
})

test('issue', async ({page}) => {
    await open(page, '/p/primes/issues/PRM-3')
    await expect(page.getByText('Nordre is working on this')).toBeVisible()
    await shoot(page, 'issue')
})

test('sessions', async ({page}) => {
    await open(page, '/sessions')
    await expect(page.locator('#session-readme-nordre')).toBeVisible()
    await shoot(page, 'sessions')
})

test('chat', async ({page}) => {
    await open(page, '/p/primes?view=list')
    await page.getByRole('button', {name: 'Agent', exact: true}).click()
    await expect(page.getByRole('heading', {name: 'Ask about Primes'})).toBeVisible()
    await shoot(page, 'chat')
})

test('docs', async ({page}) => {
    await open(page, '/p/primes/docs/how-the-sieve-works')
    await expect(page.getByRole('heading', {name: 'How the sieve works'}).first()).toBeVisible()
    await shoot(page, 'docs')
})

test('schedules', async ({page}) => {
    await open(page, '/schedules?project=primes')
    for (const title of ['Groom the backlog', 'Benchmark the sieves each week']) {
        await page.getByRole('button', {name: 'New schedule in Primes'}).click()
        const dialog = page.getByRole('dialog', {name: 'New schedule'})
        await dialog.getByLabel('Title').fill(title)
        await dialog.getByRole('button', {name: /Create schedule/}).click()
        await expect(dialog).toBeHidden()
    }
    await expect(page.getByRole('button', {name: /Benchmark the sieves/}).first()).toBeVisible()
    await shoot(page, 'schedules')
})
