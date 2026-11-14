import {expect, test} from './test'
import {OWNER, makeProject, projectApi} from './support'

// An agent's question waits in the bell until the owner answers it. The issues are the owner's, so what agents say on them
// is directed at them and rings the bell (ORR-1151).

const api = projectApi('porch')

test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Porch', key: 'POR'})
})

test("an agent's question waits in the bell until the owner answers it", async ({page, request}) => {
    const issue = await api(request, 'post', '/issues', {title: 'Pick a hinge', status: 'todo', assignee: 'owner'})
    await api(request, 'post', `/issues/${issue.id}/comments`, {body: 'Oak or pine for the hinges?', asks: 'decision'})
    await page.goto('/mine')
    const bell = page.getByRole('link', {name: /waiting on you/})
    await expect(bell).toBeVisible()
    await bell.click()
    await expect(page).toHaveURL(/\/notifications/)
    await expect(page.getByRole('button', {name: `${issue.id}: Pick a hinge`}).or(page.getByRole('link', {name: `${issue.id}: Pick a hinge`})).first()).toBeVisible()

    await api(request, 'post', `/issues/${issue.id}/comments`, {body: 'Oak.'}, OWNER)
    await page.goto('/mine')
    await expect(page.getByRole('link', {name: /waiting on you/})).toBeHidden()
})

test("clearing an agent's proposal takes it out of the bell and leaves it pending", async ({page, request}) => {
    const proposal = await api(request, 'post', '/issues', {title: 'Paint the porch', notes: 'Grey, to match the steps.', proposal: 'pending'})
    await page.goto('/notifications')
    const row = page.getByRole('listitem').filter({has: page.getByRole('button', {name: `${proposal.id}: Paint the porch`})})
    await expect(row).toBeVisible()
    await row.hover()
    await row.getByRole('button', {name: 'Clear this notice'}).click()
    await expect(row).toBeHidden()
    expect((await api(request, 'get', `/issues/${proposal.id}`)).proposal).toBe('pending')
})

test('Notifications is a list and a reading pane: a line says what happened and opens beside it, read only then (ORR-785, ORR-803)', async ({page, request}) => {
    const issue = await api(request, 'post', '/issues', {title: 'Sand the rail', status: 'todo', assignee: 'owner'})
    const other = await api(request, 'post', '/issues', {title: 'Oil the rail', status: 'todo', assignee: 'owner'})
    for (const body of ['First coat is on.', 'Second coat is on.']) await api(request, 'post', `/issues/${issue.id}/comments`, {body})
    await api(request, 'post', `/issues/${other.id}/comments`, {body: 'Oiled, see [the tin](https://example.com/tin).'})
    await api(request, 'patch', `/issues/${issue.id}`, {status: 'done'})

    // With the pane closed, so nothing is read before a line is chosen.
    await page.addInitScript(() => localStorage.setItem('orrery-notifications-pane', 'closed'))
    await page.goto('/notifications')
    const today = page.locator('section').filter({has: page.getByRole('heading', {level: 2, name: /^Today/})})
    await expect(today.getByRole('heading', {level: 2})).toContainText('unread')
    const line = (id: string, title: string) => today.getByRole('listitem').filter({has: page.getByRole('button', {name: `${id}: ${title}`})})
    const sand = line(issue.id, 'Sand the rail')
    const oil = line(other.id, 'Oil the rail')
    const toggle = sand.getByRole('button', {name: `${issue.id}: Sand the rail`})
    // One line for the two comments, saying what happened; with no change, its comment's first line, without Markdown.
    await expect(sand).toContainText('Todo')
    await expect(sand).toContainText('Done')
    await expect(oil).toContainText('Oiled, see the tin.')
    const state = (row: typeof sand) => row.locator('[data-state]').getAttribute('data-state')
    expect(await state(sand)).toBe('unread')
    await page.reload()
    await expect(toggle).toBeVisible()
    expect(await state(sand)).toBe('unread')

    // Choosing it shows both comments and the change beside the list, with a link to the issue, and it's read, on the server too.
    const pane = page.getByRole('article')
    await expect(pane).toBeHidden()
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-current', 'true')
    await expect(toggle).toBeVisible()
    await expect(pane.getByText('First coat is on.')).toBeVisible()
    await expect(pane.getByText('Second coat is on.')).toBeVisible()
    await expect(pane.getByRole('listitem').filter({hasText: 'Todo'})).toContainText('Done')
    await expect(pane.getByRole('link', {name: `Open ${issue.id}`})).toBeVisible()
    await expect.poll(() => state(sand)).toBe('read')
    expect(await state(oil)).toBe('unread')
    await expect.poll(async () => (await (await request.get('/api/notices?list=inbox')).json() as {issue: string, read?: boolean}[]).filter(n => n.issue === issue.id).every(n => n.read)).toBe(true)
    await page.reload()
    await expect(pane.getByText('First coat is on.')).toBeVisible()
    expect(await state(sand)).toBe('read')

    // Clear read takes that one and leaves the unread.
    await page.getByRole('button', {name: 'Clear read', exact: true}).click()
    await expect(sand).toBeHidden()
    await expect(pane).toBeHidden()
    await expect(oil).toBeVisible()
})

test('Notifications leads with what waits on you, each line showing its question (ORR-803)', async ({page, request}) => {
    const issue = await api(request, 'post', '/issues', {title: 'Stain the door', status: 'todo', assignee: 'owner'})
    await api(request, 'post', `/issues/${issue.id}/comments`, {body: '**Where it stands:** primed.\n\n**Walnut or oak?**', asks: 'decision'})
    await page.goto('/notifications')
    const waiting = page.getByRole('region', {name: 'Waiting on you'})
    const line = waiting.getByRole('listitem').filter({has: page.getByRole('button', {name: `${issue.id}: Stain the door`})})
    await expect(line).toContainText('Walnut or oak?')
    expect(await line.locator('[data-state]').getAttribute('data-state')).toBe('waiting')
})

test('A wide window opens with the first line beside the list; closing it gives the list the page, remembered until a line is chosen (ORR-805, ORR-990)', async ({page, request}) => {
    await page.setViewportSize({width: 1280, height: 800})
    const issue = await api(request, 'post', '/issues', {title: 'Plane the shelf', status: 'todo', assignee: 'owner'})
    await api(request, 'post', `/issues/${issue.id}/comments`, {body: 'Planed.'})
    await page.goto('/notifications')
    const toggle = page.getByRole('button', {name: `${issue.id}: Plane the shelf`})
    const pane = page.getByRole('article')
    await expect(toggle).toBeVisible()
    await expect(pane).toBeVisible()
    expect((await toggle.boundingBox())!.width).toBeLessThan(500)

    await pane.getByRole('button', {name: 'Close this notification'}).click()
    await expect(pane).toBeHidden()
    await expect(page).not.toHaveURL(/open=/)
    const fullWidth = (await toggle.boundingBox())!.width
    expect(fullWidth).toBeGreaterThan(800)
    await page.reload()
    await expect(toggle).toBeVisible()
    await expect(pane).toBeHidden()

    // Choosing a line opens it; choosing it again closes it.
    await toggle.click()
    await expect(pane.getByText('Planed.')).toBeVisible()
    expect((await toggle.boundingBox())!.width).toBeLessThan(500)
    await toggle.click()
    await expect(pane).toBeHidden()
    expect((await toggle.boundingBox())!.width).toBe(fullWidth)

    // A line chosen and left open: the next visit opens the pane again.
    await toggle.click()
    await expect(pane.getByText('Planed.')).toBeVisible()
    await page.goto('/notifications')
    await expect(pane).toBeVisible()
})

test('A line with several comments clears by itself, and only it goes (ORR-805)', async ({page, request}) => {
    const issue = await api(request, 'post', '/issues', {title: 'Glue the leg', status: 'todo', assignee: 'owner'})
    const other = await api(request, 'post', '/issues', {title: 'Clamp the leg', status: 'todo', assignee: 'owner'})
    for (const body of ['Glued.', 'Set.']) await api(request, 'post', `/issues/${issue.id}/comments`, {body})
    await api(request, 'post', `/issues/${other.id}/comments`, {body: 'Clamped.'})
    await page.goto('/notifications')
    const line = (id: string, title: string) => page.getByRole('listitem').filter({has: page.getByRole('button', {name: `${id}: ${title}`})})
    await line(issue.id, 'Glue the leg').getByRole('button', {name: 'Clear these 2'}).click()
    await expect(line(issue.id, 'Glue the leg')).toBeHidden()
    await expect(line(other.id, 'Clamp the leg')).toBeVisible()
    await expect.poll(async () => (await (await request.get('/api/notices?list=inbox')).json() as {issue: string}[]).filter(n => n.issue === issue.id).length).toBe(0)
})

test('On a narrow window a chosen line takes the list\'s place, and Back returns to it (ORR-803)', async ({page, request}) => {
    await page.setViewportSize({width: 390, height: 844})
    const issue = await api(request, 'post', '/issues', {title: 'Hang the gate', status: 'todo', assignee: 'owner'})
    await api(request, 'post', `/issues/${issue.id}/comments`, {body: 'Hung.'})
    await page.goto('/notifications')
    const toggle = page.getByRole('button', {name: `${issue.id}: Hang the gate`})
    await toggle.click()
    await expect(page.getByRole('article').getByText('Hung.')).toBeVisible()
    await expect(toggle).toBeHidden()
    await page.goBack()
    await expect(toggle).toBeVisible()
    await expect(page.getByRole('article')).toBeHidden()
})

test('dragging the border between the list and the open line resizes the list, remembered until a double-click (ORR-820)', async ({page, request}) => {
    await page.setViewportSize({width: 1400, height: 900})
    const issue = await api(request, 'post', '/issues', {title: 'Plane the door', status: 'todo', assignee: 'owner'})
    await api(request, 'post', `/issues/${issue.id}/comments`, {body: 'Planed a millimetre off.'})
    await page.goto('/notifications')
    await expect(page.getByRole('button', {name: `${issue.id}: Plane the door`}).first()).toBeVisible()
    // The pane is open from the start on a wide window (ORR-990).
    const border = page.getByRole('separator', {name: 'Resize the list'})
    await expect(border).toBeVisible()
    const list = border.locator('xpath=preceding-sibling::div[1]')
    const width = async () => Math.round((await list.boundingBox())!.width)
    expect(await width()).toBe(416)

    const box = (await border.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + 200)
    await page.mouse.down()
    await page.mouse.move(box.x + 150, box.y + 220, {steps: 5})
    await page.mouse.up()
    await expect.poll(width).toBeGreaterThan(540)
    const dragged = await width()

    // The arrows nudge it, and it holds across a reload.
    await border.focus()
    await page.keyboard.press('ArrowLeft')
    await expect.poll(width).toBe(dragged - 16)
    await page.reload()
    await expect(border).toBeVisible()
    await expect.poll(width).toBe(dragged - 16)

    await border.dblclick()
    await expect.poll(width).toBe(416)
    expect(await page.evaluate(() => localStorage.getItem('orrery-notifications-list-width'))).toBeNull()
})

test('A project picker keeps Notifications to one project, through a reload, and Clear read to what it shows (ORR-822)', async ({page, request}) => {
    if (!(await request.get('/api/projects/shed')).ok()) await makeProject(request, {name: 'Shed', key: 'SHD'})
    const shed = projectApi('shed')
    const porch = await api(request, 'post', '/issues', {title: 'Sweep the porch', status: 'todo', assignee: 'owner'})
    const roof = await shed(request, 'post', '/issues', {title: 'Felt the roof', status: 'todo', assignee: 'owner'})
    await api(request, 'post', `/issues/${porch.id}/comments`, {body: 'Swept.'})
    await shed(request, 'post', `/issues/${roof.id}/comments`, {body: 'Felted.'})
    await page.setViewportSize({width: 1400, height: 900})
    await page.goto('/notifications')
    const line = (id: string, title: string) => page.getByRole('listitem').filter({has: page.getByRole('button', {name: `${id}: ${title}`})})
    const sweep = line(porch.id, 'Sweep the porch')
    const felt = line(roof.id, 'Felt the roof')
    // Both read, by opening each.
    for (const [row, id, title] of [[sweep, porch.id, 'Sweep the porch'], [felt, roof.id, 'Felt the roof']] as const) {
        await row.getByRole('button', {name: `${id}: ${title}`}).click()
        await expect(row.locator('[data-state]')).not.toHaveAttribute('data-state', 'unread')
    }
    await page.locator('[data-picker="Project"]').click()
    await page.getByRole('option', {name: 'Shed', exact: true}).click()
    await expect(page).toHaveURL(/project=shed/)
    await expect(felt).toBeVisible()
    await expect(sweep).toBeHidden()
    await page.reload()
    await expect(felt).toBeVisible()
    await expect(sweep).toBeHidden()

    await page.getByRole('button', {name: 'Clear read'}).click()
    await expect(felt).toBeHidden()
    await page.locator('[data-picker="Project"]').click()
    await page.getByRole('option', {name: 'All projects'}).click()
    await expect(page).not.toHaveURL(/project=/)
    await expect(sweep).toBeVisible()
})
