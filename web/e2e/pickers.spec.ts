import {expect, test} from './test'
import {OWNER, hold, makeProject, projectApi} from './support'

// The settings that were native selects pick through the app's own picker: a project's releases, a milestone's
// priority, and where a removed status's issues go.

const api = projectApi('foundry')

// Made once; a retry of the file finds it there already.
test.beforeAll(async ({request}) => {
    if (!(await request.get('/api/projects/foundry')).ok()) await makeProject(request, {name: 'Foundry', key: 'FDY'})
})

test("picks a project's releases", async ({page, request}) => {
    await page.goto('/p/foundry/settings')
    await page.getByRole('button', {name: 'Its releases'}).click()
    await page.getByRole('option', {name: 'Its own'}).click()
    await expect.poll(async () => (await api(request, 'get', '')).release_mode).toBe('own')
    await expect(page.getByRole('button', {name: 'Its releases'})).toHaveText('Its own')
})

test("picks a milestone's priority", async ({page, request}) => {
    const milestone = await api(request, 'post', '/milestones', {title: 'Casting'})
    await page.goto(`/p/foundry/roadmap/${milestone.id}`)
    await page.getByRole('button', {name: 'Milestone priority'}).click()
    await page.getByRole('option', {name: 'P1 · High'}).click()
    await expect.poll(async () => (await api(request, 'get', `/milestones/${milestone.id}`)).priority).toBe('P1')
})

test("picks where a removed status's issues go", async ({page, request}) => {
    await request.post('/api/statuses', {data: {name: 'Cooling', kind: 'started'}, headers: OWNER})
    await page.goto('/settings#statuses')
    await page.getByRole('button', {name: 'Remove Cooling'}).click()
    await page.getByRole('button', {name: 'Move its issues to'}).click()
    await page.getByRole('option', {name: 'Done'}).click()
    await expect(page.getByRole('button', {name: 'Move its issues to'})).toHaveText('Done')
    await page.getByRole('button', {name: 'Remove', exact: true}).click()
    await expect.poll(async () => (await (await request.get('/api/statuses')).json()).some((s: {id: string}) => s.id === 'cooling')).toBe(false)
})

test('a picker works from the keyboard, and Esc in a dialog closes only the picker', async ({page}) => {
    await page.goto('/p/foundry')
    await page.getByRole('button', {name: 'New issue'}).first().click()
    const dialog = page.getByRole('dialog', {name: 'New issue'})
    const priority = dialog.getByRole('button', {name: 'Priority'})
    await expect(priority).toHaveAttribute('tabindex', '0')

    // Opens on what's picked, so ↵ straight away keeps it, and the focus is back on the button.
    await priority.focus()
    await page.keyboard.press('Enter')
    await expect(dialog.getByRole('option', {name: 'No priority'})).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Enter')
    await expect(dialog.getByRole('listbox')).toBeHidden()
    await expect(priority).toHaveText(/No priority$/)
    await expect(priority).toBeFocused()

    // Typed to narrow, ↵ picks the first that's left, even when what was picked still matches.
    await page.keyboard.press('Enter')
    await page.keyboard.type('p')
    // Headless UI lights an option a frame after the key; a person can't press ↵ inside one.
    await expect(dialog.locator('[role=option][data-headlessui-state~=active]')).toHaveText(/P0 · Urgent$/)
    await page.keyboard.press('Enter')
    await expect(priority).toHaveText(/P0 · Urgent$/)
    await page.keyboard.press('Enter')
    await page.keyboard.type('high')
    await expect(dialog.locator('[role=option][data-headlessui-state~=active]')).toHaveText(/P1 · High$/)
    await page.keyboard.press('Enter')
    await expect(priority).toHaveText(/P1 · High$/)

    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
    await expect(dialog.getByRole('listbox')).toBeHidden()
    await expect(dialog).toBeVisible()
    await expect(priority).toBeFocused()
})

test("a milestone's Focus on all is a menu the keys work", async ({page, request, baseURL}) => {
    const milestone = await api(request, 'post', '/milestones', {title: 'Pouring'})
    await api(request, 'post', '/issues', {title: 'Heat the crucible', status: 'todo', milestone: String(milestone.id)})
    const streams = ['smith', 'caster'].map(id => hold(baseURL!, `/api/projects/foundry/signals/stream?session=${id}&name=${id}&format=text`))
    try {
        await page.goto(`/p/foundry/roadmap/${milestone.id}`)
        const button = page.getByRole('button', {name: 'Focus on all Todo', exact: true})
        await button.focus()
        await page.keyboard.press('Enter')
        const menu = page.getByRole('menu')
        await expect(menu.getByRole('menuitem')).toHaveCount(3)
        await expect(menu.getByRole('menuitem').first()).toHaveText('All 2 sessions')
        await page.keyboard.press('Escape')
        await expect(menu).toBeHidden()
        await expect(button).toBeFocused()

        // ↵ opens it on its first line, so ↵ again asks them all.
        await page.keyboard.press('Enter')
        await page.keyboard.press('Enter')
        await expect(page.getByText('Sent to 2 sessions')).toBeVisible()
        await expect.poll(() => streams.every(s => s.said.text.includes('Heat the crucible'))).toBe(true)
    } finally {
        streams.forEach(s => s.stop())
    }
})

test("a new issue's labels: one made by typing it, and ticked", async ({page, request}) => {
    await page.goto('/p/foundry')
    await page.getByRole('button', {name: 'New issue'}).first().click()
    const dialog = page.getByRole('dialog', {name: 'New issue'})
    await dialog.getByLabel('Title').fill('Bank the kiln')
    await dialog.getByRole('button', {name: 'Labels'}).click()
    await page.keyboard.type('kiln')
    // Lit a frame after the key, as Headless UI does; a person can't press ↵ inside one.
    await expect(dialog.getByRole('option', {name: /Add “\s*kiln\s*”/})).toHaveAttribute('data-headlessui-state', /active/)
    await page.keyboard.press('Enter')
    // Many can be ticked, so it stays open, the new one ticked.
    await expect(dialog.getByRole('option', {name: 'kiln', exact: true})).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', {name: 'Labels'})).toContainText('kiln')
    await dialog.getByRole('button', {name: /Create issue/}).click()
    await expect(dialog).toBeHidden()
    await expect.poll(async () => (await api(request, 'get', '/issues')).find((i: {title: string}) => i.title === 'Bank the kiln')?.labels).toEqual(['kiln'])
})

// A picker that takes several (labels here) stays open while each pick saves, keeping the one before, and its Esc
// closes it without leaving the issue's page (ORR-602).
test('picks two labels in a row, and Esc closes the picker, not the page', async ({page, request}) => {
    const issue = await api(request, 'post', '/issues', {title: 'Pour the bells'})
    await page.goto(`/p/foundry/issues/${issue.id}`)
    const side = page.locator('aside')
    await side.getByRole('button', {name: 'Labels'}).click()
    const find = side.getByRole('combobox', {name: 'Labels'})
    await find.fill('bronze')
    await side.getByRole('option', {name: /Add “\s*bronze\s*”/}).click()
    await find.fill('tin')
    await side.getByRole('option', {name: /Add “\s*tin\s*”/}).click()
    await expect.poll(async () => (await api(request, 'get', `/issues/${issue.id}`)).labels).toEqual(['bronze', 'tin'])
    await expect(find).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(find).toBeHidden()
    await expect(page).toHaveURL(new RegExp(`/p/foundry/issues/${issue.id}$`))
})

test('adds a status from App settings, renames it, colours it and moves it, Esc leaving a name as it was (ORR-792)', async ({page, request}) => {
    const statuses = async () => (await (await request.get('/api/statuses')).json()) as {id: string, name: string, kind: string, color: string, position: number}[]
    const started = async () => (await statuses()).filter(s => s.kind === 'started').map(s => s.id)
    await page.goto('/settings#statuses')
    const startedGroup = page.locator('div.rounded-xl').filter({has: page.getByRole('textbox', {name: "In progress's name"})}).first()

    // Esc closes the new one's box, adding nothing.
    await startedGroup.getByRole('button', {name: '+ Add'}).click()
    await page.getByLabel("New status's name").fill('Simmering')
    await page.getByLabel("New status's name").press('Escape')
    await expect(page.getByLabel("New status's name")).toHaveCount(0)
    expect(await started()).not.toContain('simmering')

    await startedGroup.getByRole('button', {name: '+ Add'}).click()
    await page.getByLabel("New status's name").fill('Simmering')
    await startedGroup.getByRole('button', {name: 'Add', exact: true}).click()
    await expect.poll(started).toContain('simmering')
    expect((await started()).at(-1)).toBe('simmering')

    // Renamed in place: Enter saves, Esc puts the name back.
    const name = page.getByRole('textbox', {name: "Simmering's name"})
    await name.fill('Bubbling')
    await name.press('Enter')
    await expect.poll(async () => (await statuses()).find(s => s.id === 'simmering')?.name).toBe('Bubbling')
    const renamed = page.getByRole('textbox', {name: "Bubbling's name"})
    await renamed.fill('Boiling over')
    await renamed.press('Escape')
    await expect(renamed).toHaveValue('Bubbling')
    expect((await statuses()).find(s => s.id === 'simmering')?.name).toBe('Bubbling')

    await page.getByRole('button', {name: 'Colour Bubbling teal'}).click()
    await expect.poll(async () => (await statuses()).find(s => s.id === 'simmering')?.color).toBe('teal')

    // Last in its kind, it can't go down; up swaps it with the one before.
    await expect(page.getByRole('button', {name: 'Move Bubbling down'})).toBeDisabled()
    const before = await started()
    await page.getByRole('button', {name: 'Move Bubbling up'}).click()
    await expect.poll(started).toEqual([...before.slice(0, -2), 'simmering', before.at(-2)])
    await page.getByRole('button', {name: 'Move Bubbling down'}).click()
    await expect.poll(started).toEqual(before)

    // Cancel leaves it; nothing uses it, so Remove takes it.
    await page.getByRole('button', {name: 'Remove Bubbling'}).click()
    await startedGroup.getByRole('button', {name: 'Cancel'}).click()
    await expect(page.getByRole('button', {name: 'Move its issues to'})).toHaveCount(0)
    await page.getByRole('button', {name: 'Remove Bubbling'}).click()
    await page.getByRole('button', {name: 'Remove', exact: true}).click()
    await expect.poll(started).not.toContain('simmering')
})
