import type {APIRequestContext, Page} from '@playwright/test'
import {expect, test} from '@playwright/test'

// The keys (useHotkeys), on a project of their own: j/k between rows and group headers and Enter to open, j/k and Esc on
// an issue's page, 1/2 for List and Board, / and c, x and Esc to tick and clear, g m.
// Runs after first-run.spec.ts on the same orrery, so the owner is usually named already; named here if not.

const api = (request: APIRequestContext, method: 'get' | 'post' | 'put', path: string, data?: object) =>
    request[method](`/api${path}`, {data}).then(async r => {
        expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBeTruthy()
        return r.json()
    })

/** The project as a list, once its rows are there: the keys listen from then on, so a key pressed sooner is lost. */
async function open(page: Page) {
    await page.goto('/p/keys?view=list')
    const rows = page.locator('main [data-nav][data-issue]')
    await expect(rows).toHaveCount(3)
    return rows
}

test.beforeAll(async ({request}) => {
    if (!(await api(request, 'get', '/owner')).named) await api(request, 'put', '/owner', {name: 'Ada Lovelace'})
    await api(request, 'post', '/projects', {name: 'Keys', key: 'KEY'})
    for (const title of ['First key', 'Second key', 'Third key']) await api(request, 'post', '/projects/keys/issues', {title, status: 'todo'})
})

test('j and k move between rows and group headers, Enter opens the one in focus', async ({page}) => {
    const rows = await open(page)
    // The Todo group's header, then its three rows.
    const nav = page.locator('main [data-nav]')
    await expect(nav).toHaveCount(4)
    const order = await rows.evaluateAll(els => els.map(el => (el as HTMLElement).dataset.issue!))
    await page.keyboard.press('j')
    await expect(nav.nth(0)).toHaveAttribute('aria-expanded', 'true')
    await expect(nav.nth(0)).toBeFocused()
    await page.keyboard.press('j')
    await expect(nav.nth(1)).toBeFocused()
    await page.keyboard.press('j')
    await page.keyboard.press('j')
    await expect(nav.nth(3)).toBeFocused()
    // At the last row j stays put; k goes back up.
    await page.keyboard.press('j')
    await expect(nav.nth(3)).toBeFocused()
    await page.keyboard.press('k')
    await expect(nav.nth(2)).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(`/p/keys/issues/${order[1]}`)
})

test("on an issue's page j and k step to the next and previous issue, Esc goes back", async ({page}) => {
    const rows = await open(page)
    const order = await rows.evaluateAll(els => els.map(el => (el as HTMLElement).dataset.issue!))
    await rows.nth(0).click()
    await expect(page).toHaveURL(`/p/keys/issues/${order[0]}`)
    await page.keyboard.press('j')
    await expect(page).toHaveURL(`/p/keys/issues/${order[1]}`)
    await page.keyboard.press('k')
    await expect(page).toHaveURL(`/p/keys/issues/${order[0]}`)
    // Before the first there's nothing, so k stays.
    await page.keyboard.press('k')
    await expect(page).toHaveURL(`/p/keys/issues/${order[0]}`)
    await page.keyboard.press('Escape')
    await expect(page).toHaveURL(/\/p\/keys(\?view=list)?$/)
})

test('1 and 2 switch between List and Board', async ({page}) => {
    await open(page)
    await page.keyboard.press('2')
    await expect(page).toHaveURL(/view=board/)
    await page.keyboard.press('1')
    await expect(page).toHaveURL(/view=list/)
})

test('/ goes to the search, and c writes a new issue', async ({page}) => {
    await open(page)
    await page.keyboard.press('/')
    await expect(page.locator('#search')).toBeFocused()
    // Typing in the search is typing, not keys: c there is a letter.
    await page.keyboard.press('c')
    await expect(page.getByRole('dialog', {name: 'New issue'})).toBeHidden()
    await page.keyboard.press('Escape')
    await expect(page.locator('#search')).not.toBeFocused()
    await page.keyboard.press('c')
    const dialog = page.getByRole('dialog', {name: 'New issue'})
    // Its title takes the cursor on the first open too, while the dialog is still loading.
    await expect(dialog.getByLabel('Title')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
})

test('x ticks the issue in focus, Esc clears the ticks', async ({page}) => {
    const rows = await open(page)
    const first = await rows.nth(0).getAttribute('data-issue')
    // Past the group's header to its first row.
    await page.keyboard.press('j')
    await page.keyboard.press('j')
    await expect(rows.nth(0)).toBeFocused()
    await page.keyboard.press('x')
    await expect(page.getByRole('checkbox', {name: `Select ${first}`})).toHaveAttribute('aria-checked', 'true')
    const bar = page.getByRole('toolbar', {name: 'Change the ticked issues'})
    await expect(bar.getByText('1 selected')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(bar).toBeHidden()
})

test('g m goes to My issues', async ({page}) => {
    await open(page)
    await page.keyboard.press('g')
    await page.keyboard.press('m')
    await expect(page).toHaveURL('/mine')
})
