import {expect, test} from '@playwright/test'
import {AGENT, makeProject, projectApi} from './support'

// Pictures and comments: an image picked into a new issue and a comment, the owner editing and deleting their own
// comment but not an agent's, a Before and After pair as a slider, and copying the whole issue with its comments.
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

test('takes an image dropped or pasted anywhere on the dialog or the comment box, showing where it can go', async ({page}) => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    /** What a drag or a paste carrying the image hands over. */
    const carrying = (name: string) => page.evaluateHandle(([data, name]) => {
        const transfer = new DataTransfer()
        transfer.items.add(new File([Uint8Array.from(atob(data!), c => c.charCodeAt(0))], `${name}.png`, {type: 'image/png'}))
        return transfer
    }, [png, name])
    await page.goto('/p/studio')
    await page.getByRole('button', {name: 'New issue'}).first().click()
    const dialog = page.getByRole('dialog', {name: 'New issue'})
    const title = dialog.getByLabel('Title')
    await title.fill('Pack the crate')
    // Dragged over the title, not the description: the whole dialog says it takes it, and dragged text doesn't.
    await title.dispatchEvent('dragenter', {dataTransfer: await page.evaluateHandle(() => {
        const transfer = new DataTransfer()
        transfer.setData('text/plain', 'words')
        return transfer
    })})
    await expect(dialog.getByText('Drop image to add')).toHaveCount(0)
    const drag = await carrying('crate')
    await title.dispatchEvent('dragenter', {dataTransfer: drag})
    await dialog.getByLabel('Description').dispatchEvent('dragenter', {dataTransfer: drag})
    await title.dispatchEvent('dragleave', {dataTransfer: drag})
    // Still over the dialog, on the description.
    await expect(dialog.getByText('Drop image to add')).toBeVisible()
    await title.dispatchEvent('drop', {dataTransfer: drag})
    await expect(dialog.getByText('Drop image to add')).toHaveCount(0)
    await expect(dialog.getByLabel('Description')).toHaveValue(/^!\[crate\]\(\/api\/uploads\/[0-9a-f]{24}\)\n$/)
    await expect(dialog.getByLabel('Description')).toBeFocused()
    // Pasted while typing the title, it goes into the description too.
    await title.focus()
    const clipboard = await carrying('lid')
    await title.evaluate((field, clipboardData) => field.dispatchEvent(new ClipboardEvent('paste', {clipboardData, bubbles: true, cancelable: true})), clipboard)
    await expect(dialog.getByLabel('Description')).toHaveValue(/!\[lid\]/)
    await dialog.getByRole('button', {name: /Create issue/}).click()
    await expect(page).toHaveURL(/\/p\/studio\/issues\/STU-\d+/)

    // Dropped on the comment box's buttons, it goes into the comment.
    const box = page.locator('form').filter({has: page.getByRole('textbox', {name: 'Comment'})})
    const onBox = await carrying('hinge')
    await box.getByRole('button', {name: 'Add an image'}).dispatchEvent('dragenter', {dataTransfer: onBox})
    await expect(box.getByText('Drop image to add')).toBeVisible()
    await box.getByRole('button', {name: 'Add an image'}).dispatchEvent('drop', {dataTransfer: onBox})
    await expect(page.getByRole('textbox', {name: 'Comment'})).toHaveValue(/!\[hinge\]/)
    await expect(page.getByRole('textbox', {name: 'Comment'})).toBeFocused()
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

test('copies the whole issue, with every comment or none, and no description', async ({page, request}) => {
    const copy = page.getByRole('button', {name: 'Copy the whole issue'})
    const copied = async () => {
        await copy.click()
        await expect(copy).toHaveText('Copied')
        return page.evaluate(() => (window as unknown as {copied: string[]}).copied.at(-1))
    }
    const open = async (id: string) => {
        await page.goto(`/p/studio/issues/${id}`)
        await page.evaluate(() => {
            const list: string[] = (window as unknown as {copied: string[]}).copied = []
            navigator.clipboard.writeText = async text => { list.push(text) }
        })
    }

    const bare = await api(request, 'post', '/issues', {title: 'Sweep the floor'})
    await open(bare.id)
    await expect(copy).toBeVisible()
    expect(await copied()).toBe(`${bare.full_id}\n\n# Sweep the floor`)

    const full = await api(request, 'post', '/issues', {title: 'Paint the door', notes: 'Two coats of green'})
    const first = await api(request, 'post', `/issues/${full.id}/comments`, {body: 'Bought the paint'})
    const second = await api(request, 'post', `/issues/${full.id}/comments`, {body: 'First coat is on'})
    await open(full.id)
    await expect(page.getByText('First coat is on')).toBeVisible()
    const when = (at: string) => `${at.slice(0, 16).replace('T', ' ')} UTC`
    const whole = await copied()
    expect(whole!.startsWith(`${full.full_id}\n\n`)).toBe(true)
    expect(whole!.split('\n\n').slice(1)).toEqual([
        '# Paint the door',
        'Two coats of green',
        '---', `**Agent**, ${when(first.created_at)}`, 'Bought the paint',
        '---', `**Agent**, ${when(second.created_at)}`, 'First coat is on',
    ])

    // A comment added from the page is in the next copy.
    await page.getByRole('textbox', {name: /comment/i}).first().fill('Second coat tomorrow')
    await page.getByRole('button', {name: 'Comment', exact: true}).click()
    await expect(page.getByText('Second coat tomorrow')).toBeVisible()
    await expect(copy).toHaveText('Copy issue')
    expect(await copied()).toContain('Second coat tomorrow')
})
