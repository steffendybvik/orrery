import {expect, test} from '@playwright/test'
import {AGENT, makeProject} from './support'

// The owner writes, edits and removes docs from the page. A doc an agent changed is tinted in the list, and in it
// the parts changed since the owner read it.
test.describe.configure({mode: 'serial'})

test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Library', key: 'LIB'})
    await makeProject(request, {name: 'Archive', key: 'ARC'})
})

test('writes a doc, edits it in place and removes it', async ({page}) => {
    await page.goto('/p/archive/docs')
    await page.getByRole('button', {name: 'New doc'}).first().click()
    const dialog = page.getByRole('dialog', {name: 'New doc'})
    await dialog.getByLabel('Title').fill('How we file')
    await dialog.getByLabel('Text').fill('Boxes by **year**.')
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(page).toHaveURL(/\/p\/archive\/docs\/how-we-file$/)
    await expect(page.locator('.doc strong', {hasText: 'year'})).toBeVisible()

    await page.getByRole('button', {name: 'Edit'}).click()
    await page.getByLabel('Title').fill('How we file things')
    await page.getByLabel('Text').fill('Boxes by year, then by month.')
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(page.getByRole('heading', {level: 1, name: 'How we file things'})).toBeVisible()
    await expect(page.getByText('Boxes by year, then by month.')).toBeVisible()
    // Your own edit isn't tinted as a change to read.
    await expect(page.locator('.doc .changed')).toHaveCount(0)

    await page.getByRole('button', {name: 'Remove'}).click()
    await page.getByRole('button', {name: 'Remove'}).click()
    await expect(page.getByText('Archive has no docs yet.')).toBeVisible()
})

test("tints a doc an agent changed, and in it the parts that changed since the owner read it", async ({page, request}) => {
    const put = (id: string, body: string) => request.put(`/api/projects/library/docs/${id}`, {data: {title: id === 'pantry' ? 'Pantry' : 'Shelves', body}, headers: AGENT})
        .then(r => expect(r.ok()).toBeTruthy())
    await put('pantry', 'Keep flour dry.\n\nLabel the jars.')
    await put('shelves', 'Top shelf for tins.')
    await page.goto('/p/library/docs/pantry')
    await expect(page.getByText('Label the jars.')).toBeVisible()
    await expect(page.locator('.doc .changed')).toHaveCount(0)

    // Reading another doc while an agent changes this one.
    await page.goto('/p/library/docs/shelves')
    await expect(page.getByText('Top shelf for tins.')).toBeVisible()
    await put('pantry', 'Keep flour dry.\n\nLabel every jar with its date.\n\nRestock on Fridays.')
    const row = page.getByRole('link', {name: /^Pantry/})
    await expect(row).toHaveClass(/unseen-row/)
    await row.click()
    await expect(page.locator('.doc .changed')).toHaveText(['Label every jar with its date.', 'Restock on Fridays.'])
    await expect(page.getByText('2 parts changed since you last read it, tinted below')).toBeVisible()
})
