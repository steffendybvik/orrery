import type {APIRequestContext, Page} from '@playwright/test'
import {expect, test} from '@playwright/test'
import {makeProject, OWNER} from './support'

// What the board and an issue's page look like, against images kept in `visual.spec.ts-snapshots/`, so a change
// that moves them without meaning to shows up. The images are Linux's, made in CI's Playwright image, so a plain
// `pnpm test:e2e` elsewhere skips them; `pnpm test:e2e:visual` runs them in that image (with `--update-snapshots`
// it makes them anew). A project of its own, so the page holds only what this file made; the owner named if no
// one has yet; and starting sessions off, as earlier files may leave it on, which changes what the sessions panel says.
test.skip(process.platform !== 'linux', "The images are Linux's: run `pnpm test:e2e:visual`")
test.describe.configure({mode: 'serial'})
test.use({viewport: {width: 1280, height: 800}, colorScheme: 'light'})

// The bell counts what earlier files left unread, so it's left out of every image.
const shoot = (page: Page, name: string) => expect(page.locator('main')).toHaveScreenshot(name, {
    mask: [page.getByRole('link', {name: /comments from agents|waiting on you/i})],
})

const api = async (request: APIRequestContext, method: 'get' | 'post' | 'put' | 'patch', path: string, data?: object, headers?: Record<string, string>) => {
    const r = await request[method](`/api${path}`, {data, headers})
    expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBeTruthy()
    return r.json()
}

let starts: unknown = null

test.beforeAll(async ({request}) => {
    if (!(await api(request, 'get', '/owner')).named) await api(request, 'put', '/owner', {name: 'Ada Lovelace'})
    starts = (await api(request, 'get', '/settings')).starts ?? null
    await api(request, 'patch', '/settings', {starts: null}, OWNER)
    await makeProject(request, {name: 'Gallery', key: 'GAL'})
    const {id: chunk} = await api(request, 'post', '/projects/gallery/chunks', {title: 'Hanging'})
    const issues = [
        {title: 'Hang the portraits in the east wing', status: 'in-progress', priority: 'P1', labels: ['bug']},
        {title: 'Light the sculpture hall', status: 'todo', priority: 'P2'},
        {title: 'Label every frame', status: 'todo', priority: 'P3', labels: ['feature request']},
        {title: 'Reframe the watercolours', status: 'backlog'},
        {title: 'Open the doors', status: 'done', priority: 'P2'},
    ]
    for (const issue of issues) await api(request, 'post', '/projects/gallery/issues', {...issue, chunk})
    await api(request, 'post', '/projects/gallery/issues/GAL-1/comments', {body: 'Started on the **east wing**: three of eight up.'}, {'Orrery-Actor': 'claude'})
})

test.afterAll(async ({request}) => {
    await api(request, 'patch', '/settings', {starts}, OWNER)
})

test('the board looks as it did', async ({page}) => {
    await page.goto('/p/gallery?view=board')
    await expect(page.locator('[data-issue="GAL-1"]')).toBeVisible()
    await shoot(page, 'board.png')
})

test('the list looks as it did', async ({page}) => {
    await page.goto('/p/gallery?view=list')
    await expect(page.locator('[data-issue="GAL-1"]')).toBeVisible()
    await shoot(page, 'list.png')
})

test("an issue's page looks as it did", async ({page}) => {
    await page.goto('/p/gallery/issues/GAL-1')
    await expect(page.getByText('three of eight up')).toBeVisible()
    await shoot(page, 'issue.png')
})
