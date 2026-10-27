import {expect, test} from '@playwright/test'
import {AGENT, makeProject, projectApi} from './support'

// Pictures and comments: an image picked into a new issue and a comment, the owner editing and deleting their own
// comment but not an agent's, and a Before and After pair as a slider.
test.describe.configure({mode: 'serial'})

const api = projectApi('studio')

test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Studio', key: 'STU'})
})

test('puts a picked image in a new issue, and in a comment on it', async ({page, request}) => {
    // A 1×1 PNG.
    const png = {name: 'shelf.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')}
    await page.goto('/p/studio')
    await page.getByRole('button', {name: 'New issue'}).first().click()
    const dialog = page.getByRole('dialog', {name: 'New issue'})
    await dialog.getByLabel('Title').fill('Label the top shelf')
    await dialog.locator('input[type="file"]').setInputFiles(png)
    await expect(dialog.getByLabel('Description')).toHaveValue(/^!\[shelf\]\(\/api\/uploads\/[0-9a-f]{24}\)\n$/)
    await dialog.getByRole('button', {name: /Create issue/}).click()
    await expect(page).toHaveURL(/\/p\/studio\/issues\/STU-\d+/)
    const id = page.url().split('/').at(-1)!
    const image = page.locator('.doc img[alt="shelf"]').first()
    await expect(image).toBeVisible()
    expect(await image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1)

    await page.locator('form').filter({has: page.getByRole('textbox', {name: 'Comment'})}).locator('input[type="file"]').setInputFiles(png)
    await expect(page.getByRole('textbox', {name: 'Comment'})).toHaveValue(/!\[shelf\]/)
    await page.getByRole('button', {name: 'Comment', exact: true}).click()
    await expect.poll(async () => (await api(request, 'get', `/issues/${id}/comments`)).at(-1)?.body).toMatch(/^!\[shelf\]\(\/api\/uploads\//)
})

test("edits and deletes the owner's own comment, but not an agent's", async ({page, request}) => {
    const {id} = await api(request, 'post', '/issues', {title: 'Oil the hinges'})
    await api(request, 'post', `/issues/${id}/comments`, {body: 'Bought the oil'})
    await page.goto(`/p/studio/issues/${id}`)
    await page.getByRole('textbox', {name: 'Comment'}).fill('Use the thin oil')
    await page.getByRole('button', {name: 'Comment', exact: true}).click()
    const mine = page.locator('li').filter({hasText: 'Use the thin oil'})
    await expect(mine).toBeVisible()
    await expect(page.locator('li').filter({hasText: 'Bought the oil'}).getByRole('button', {name: 'Edit'})).toHaveCount(0)

    await mine.hover()
    await mine.getByRole('button', {name: 'Edit'}).click()
    const field = page.getByRole('textbox', {name: 'Edit comment'})
    await expect(field).toHaveValue('Use the thin oil')
    await field.fill('Use the thick oil')
    await field.press('Meta+Enter')
    await expect(page.locator('li').filter({hasText: 'Use the thick oil'})).toContainText('edited')
    expect((await api(request, 'get', `/issues/${id}/comments`)).at(-1)).toMatchObject({body: 'Use the thick oil'})

    const edited = page.locator('li').filter({hasText: 'Use the thick oil'})
    await edited.hover()
    await edited.getByRole('button', {name: 'Delete'}).click()
    await edited.getByRole('button', {name: 'Delete', exact: true}).click()
    await expect(edited).toHaveCount(0)
    expect((await api(request, 'get', `/issues/${id}/comments`)).map((c: {body: string}) => c.body)).toEqual(['Bought the oil'])
})

test('turns a Before and an After picture into a slider between them', async ({page, request}) => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const [before, after] = await Promise.all(['before', 'after'].map(name => request.post('/api/uploads', {data: {data: png, name}, headers: AGENT}).then(r => r.json())))
    const {id} = await api(request, 'post', '/issues', {title: 'Relabel the jars'})
    await api(request, 'post', `/issues/${id}/comments`, {body: `The jars:\n\n![Before: the jars](${before.url})\n![After: the jars](${after.url})\n\n![A lone picture](${after.url})`})
    await page.goto(`/p/studio/issues/${id}`)
    const slider = page.locator('.doc .compare')
    await expect(slider).toHaveCount(1)
    await expect(slider.getByRole('link', {name: 'Before'})).toHaveAttribute('href', before.url)
    await expect(slider.getByRole('link', {name: 'After'})).toHaveAttribute('href', after.url)
    // A picture on its own stays one.
    await expect(page.locator('.doc a > img[alt="A lone picture"]')).toBeVisible()
    const range = slider.getByRole('slider', {name: /Before: the jars/})
    await range.focus()
    await page.keyboard.press('ArrowRight')
    await expect(slider).toHaveAttribute('style', /--split: 51%/)
})
