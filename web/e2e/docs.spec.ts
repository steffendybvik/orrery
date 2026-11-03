import {expect, test} from '@playwright/test'
import {AGENT, makeProject} from './support'

// The owner writes, edits and removes docs from the page. A doc an agent changed is tinted in the list, and in it
// the parts changed since the owner read it.

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
    const row = page.locator('a[href="/p/library/docs/pantry"]')
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

test('drags a section above another, and it stays there after a reload (ORR-767)', async ({page, request}) => {
    await makeProject(request, {name: 'Shelves', key: 'SHE'})
    for (const name of ['Alpha', 'Beta', 'Gamma']) await request.post('/api/projects/shelves/doc-sections', {data: {name}, headers: AGENT})
    await request.put('/api/projects/shelves/docs/first', {data: {title: 'First', body: 'First.', section: 'Alpha'}, headers: AGENT})
    const order = async () => await (await request.get('/api/projects/shelves/doc-sections')).json()

    await page.goto('/p/shelves/docs/first')
    const nav = page.getByRole('navigation', {name: 'Docs'})
    const header = (name: string) => nav.getByRole('region', {name}).getByRole('button', {name: new RegExp(`^${name}`, 'i')})
    const shown = () => nav.getByRole('region').evaluateAll(sections => sections.map(section => section.getAttribute('aria-label')))
    await expect.poll(shown).toEqual(['Alpha', 'Beta', 'Gamma'])

    // Above the first, by its top half.
    await header('Gamma').dragTo(header('Alpha'), {targetPosition: {x: 20, y: 2}})
    await expect.poll(order).toEqual(['Gamma', 'Alpha', 'Beta'])
    await expect.poll(shown).toEqual(['Gamma', 'Alpha', 'Beta'])

    // Below the last, past its docs.
    await header('Gamma').dragTo(nav.getByRole('region', {name: 'Beta'}), {targetPosition: {x: 20, y: 20}})
    await expect.poll(order).toEqual(['Alpha', 'Beta', 'Gamma'])

    // And by the keys, which keep the header focused.
    await header('Gamma').focus()
    await page.keyboard.press('Alt+ArrowUp')
    await expect.poll(order).toEqual(['Alpha', 'Gamma', 'Beta'])
    await expect(header('Gamma')).toBeFocused()

    await page.reload()
    await expect.poll(shown).toEqual(['Alpha', 'Gamma', 'Beta'])

    // Dropping a doc on a section still files it, and doesn't move the section.
    await nav.getByRole('link', {name: 'First'}).dragTo(header('Beta'))
    await expect.poll(async () => (await (await request.get('/api/projects/shelves/docs/first')).json()).section).toBe('Beta')
    expect(await order()).toEqual(['Alpha', 'Gamma', 'Beta'])
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

test("a doc's text keeps its reading width, and On this page shows only where there's room for both", async ({page, request}) => {
    await request.put('/api/projects/library/docs/seasons', {data: {title: 'The seasons', body: '## Spring\n\nSow the first beds.\n\n## Summer\n\nWater early.'}, headers: AGENT})
    const contents = page.getByRole('navigation', {name: 'On this page'})
    const article = page.locator('article').first()

    await page.setViewportSize({width: 1280, height: 800})
    await page.goto('/p/library/docs/seasons')
    await expect(page.getByRole('heading', {name: 'Spring'})).toBeVisible()
    await expect(contents).toBeHidden()
    expect((await article.boundingBox())!.width).toBeGreaterThan(650)

    await page.setViewportSize({width: 1700, height: 800})
    await expect(contents).toBeVisible()
    expect((await article.boundingBox())!.width).toBeGreaterThanOrEqual(760)
})
