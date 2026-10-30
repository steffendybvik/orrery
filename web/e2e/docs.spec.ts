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

test("shows a doc's history, restores a version, and brings a removed doc back (ORR-675)", async ({page, request}) => {
    const url = '/api/projects/library/docs/ledger'
    await request.put(url, {data: {title: 'Ledger', body: 'Count the jars.\n\nWrite it down.'}, headers: AGENT}).then(r => expect(r.ok()).toBeTruthy())
    await request.put(url, {data: {title: 'Ledger', body: 'Count the jars weekly.\n\nWrite it down.'}, headers: AGENT}).then(r => expect(r.ok()).toBeTruthy())

    await page.goto('/p/library/docs/ledger')
    await page.getByRole('button', {name: 'History'}).click()
    const history = page.getByRole('region', {name: 'History'})
    await expect(history.locator('[data-diff="added"]')).toHaveText(/Count the jars weekly\./)
    await expect(history.locator('[data-diff="removed"]')).toHaveText(/Count the jars\./)
    // The newest is what the doc already says, so there's nothing to restore there.
    await expect(history.getByRole('button', {name: 'Restore this version'})).toHaveCount(0)

    await history.getByRole('button', {name: /First version/}).click()
    await history.getByRole('button', {name: 'Restore this version'}).click()
    await history.getByRole('button', {name: 'Restore', exact: true}).click()
    await expect(page.locator('.doc')).toContainText('Count the jars.')
    await expect(page.locator('.doc')).not.toContainText('weekly')

    await page.getByRole('button', {name: 'History'}).click()
    await expect(history.getByRole('listitem')).toHaveCount(3)
    await page.getByRole('button', {name: 'Back to the doc'}).click()

    await page.getByRole('button', {name: 'Remove'}).click()
    await page.getByRole('button', {name: 'Remove'}).click()
    await page.goto('/p/library/docs/ledger')
    await expect(page.getByText('Its past is kept')).toBeVisible()
    await page.getByRole('button', {name: 'Bring it back'}).click()
    await page.getByRole('button', {name: 'Bring back', exact: true}).click()
    await expect(page.locator('.doc')).toContainText('Count the jars.')
    await expect(page.getByRole('heading', {level: 1, name: 'Ledger'})).toBeVisible()
    await request.delete(url, {headers: AGENT})
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

test('groups the docs into sections, folds one, and moves a doc by right-click and by dragging (ORR-520)', async ({page, request}) => {
    const put = (id: string, title: string, section?: string) => request.put(`/api/projects/library/docs/${id}`, {data: {title, body: `${title}.`, ...section ? {section} : {}}, headers: AGENT})
    await put('readme', 'Readme')
    await put('decision-ids', 'Decision: ids', 'Decisions')
    await put('decision-owner', 'Decision: owner', 'Decisions')
    await put('event-flows', 'Event flows')
    await page.goto('/p/library/docs/readme')
    const nav = page.getByRole('navigation', {name: 'Docs'})
    const decisions = nav.getByRole('region', {name: 'Decisions'})
    await expect(decisions.getByRole('link')).toHaveText(['Decision: ids', 'Decision: owner'])

    // Folded, it stays folded on the next visit.
    await decisions.getByRole('button', {name: /Decisions/}).click()
    await expect(decisions.getByRole('link', {name: 'Decision: ids'})).toBeHidden()
    await page.reload()
    await expect(nav.getByRole('region', {name: 'Decisions'}).getByRole('link', {name: 'Decision: ids'})).toBeHidden()
    await nav.getByRole('region', {name: 'Decisions'}).getByRole('button', {name: /Decisions/}).click()

    // The section with the open doc folds too, and the doc stays open (ORR-712).
    await decisions.getByRole('link', {name: 'Decision: ids'}).click()
    await expect(page).toHaveURL(/\/docs\/decision-ids$/)
    const header = decisions.getByRole('button', {name: /Decisions/})
    await header.click()
    await expect(header).toHaveAttribute('aria-expanded', 'false')
    await expect(decisions.getByRole('link', {name: 'Decision: ids'})).toBeHidden()
    await expect(page.getByRole('heading', {name: 'Decision: ids', level: 1})).toBeVisible()

    // It stays folded on the way to a doc elsewhere, and opening one of its docs unfolds it.
    await nav.getByRole('link', {name: 'Readme'}).click()
    await expect(page).toHaveURL(/\/docs\/readme$/)
    await expect(decisions.getByRole('link', {name: 'Decision: ids'})).toBeHidden()
    await page.goBack()
    await expect(page).toHaveURL(/\/docs\/decision-ids$/)
    await expect(header).toHaveAttribute('aria-expanded', 'true')
    await expect(decisions.getByRole('link', {name: 'Decision: ids'})).toBeVisible()
    await page.reload()
    await expect(decisions.getByRole('link', {name: 'Decision: ids'})).toBeVisible()
    await nav.getByRole('link', {name: 'Readme'}).click()

    // Right-click: into a new section.
    await nav.getByRole('link', {name: 'Event flows'}).click({button: 'right'})
    const menu = page.getByRole('menu', {name: 'Move Event flows'})
    await menu.getByRole('button', {name: '+ New section…'}).click()
    await menu.getByLabel('New section').fill('How it works')
    await menu.getByLabel('New section').press('Enter')
    await expect(nav.getByRole('region', {name: 'How it works'}).getByRole('link')).toHaveText(['Event flows'])
    expect((await (await request.get('/api/projects/library/docs/event-flows')).json()).section).toBe('How it works')

    // Dragged onto Decisions; then back out onto Docs.
    await nav.getByRole('link', {name: 'Event flows'}).dragTo(nav.getByRole('region', {name: 'Decisions'}).getByRole('button', {name: /Decisions/}))
    await expect(nav.getByRole('region', {name: 'Decisions'}).getByRole('link')).toHaveText(['Decision: ids', 'Decision: owner', 'Event flows'])
    await expect(nav.getByRole('region', {name: 'How it works'})).toHaveCount(0)
    await nav.getByRole('link', {name: 'Event flows'}).dragTo(nav.getByText('Docs', {exact: true}))
    await expect.poll(async () => (await (await request.get('/api/projects/library/docs/event-flows')).json()).section).toBeUndefined()
})

test('makes an empty section, renames one on all its docs and deletes one keeping its docs (ORR-560)', async ({page, request}) => {
    const put = (id: string, title: string, section?: string) => request.put(`/api/projects/archive/docs/${id}`, {data: {title, body: `${title}.`, ...section ? {section} : {}}, headers: AGENT})
    await put('decision-boxes', 'Decision: boxes', 'Decisions')
    await put('decision-labels', 'Decision: labels', 'Decisions')
    await page.goto('/p/archive/docs/decision-boxes')
    const nav = page.getByRole('navigation', {name: 'Docs'})

    // Made at the foot, empty, and something a doc can be moved into.
    await nav.getByRole('button', {name: 'New section', exact: true}).click()
    await nav.getByLabel('New section').fill('Research')
    await nav.getByLabel('New section').press('Enter')
    await expect(nav.getByRole('region', {name: 'Research'}).getByRole('button', {name: /Research/})).toContainText('0')
    await expect.poll(async () => (await (await request.get('/api/projects/archive/doc-sections')).json())).toEqual(['Decisions', 'Research'])

    // Renamed by right-clicking its header: every doc in it moves with it.
    await nav.getByRole('region', {name: 'Decisions'}).getByRole('button', {name: /Decisions/}).click({button: 'right'})
    const menu = page.getByRole('menu', {name: 'Section Decisions'})
    await menu.getByRole('button', {name: 'Rename…'}).click()
    await menu.getByLabel('Rename section').fill('Choices')
    await menu.getByLabel('Rename section').press('Enter')
    await expect(nav.getByRole('region', {name: 'Choices'}).getByRole('link')).toHaveText(['Decision: boxes', 'Decision: labels'])
    await expect(nav.getByRole('region', {name: 'Decisions'})).toHaveCount(0)

    // Deleted: its docs stay, under no section.
    await nav.getByRole('region', {name: 'Choices'}).getByRole('button', {name: /Choices/}).click({button: 'right'})
    await page.getByRole('menu', {name: 'Section Choices'}).getByRole('button', {name: 'Delete section'}).click()
    await expect(nav.getByRole('region', {name: 'Choices'})).toHaveCount(0)
    await expect(nav.getByRole('link', {name: 'Decision: labels'})).toBeVisible()
    expect((await (await request.get('/api/projects/archive/docs/decision-labels')).json()).section).toBeUndefined()
})
