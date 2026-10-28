import {expect, test} from '@playwright/test'
import {OWNER, makeProject, projectApi} from './support'

// The Events page kept to a kind (ORR-401): a family picked shows every kind in it, one kind only itself, and the
// choice is in the URL, with the project's, so it's there again after a reload.
// And its lines link the issue they name, and their project, from the line itself (ORR-403), and a line is only ever a
// line: nothing opens under it (ORR-472). An error an agent resolved
// stays on the bell and says who resolved it, and the page's reports are marked and held to a few a minute (ORR-420).
const api = projectApi('ledger')
let advanced = false

test.beforeAll(async ({request}) => {
    advanced = !!(await (await request.get('/api/settings')).json()).advanced
    const on = await request.patch('/api/settings', {data: {advanced: true}, headers: OWNER})
    expect(on.ok(), await on.text()).toBeTruthy()
    if (!(await request.get('/api/projects/ledger')).ok()) await makeProject(request, {name: 'Ledger', key: 'LDG'})
    const issue = await api(request, 'post', '/issues', {title: 'Balance the books'})
    await api(request, 'patch', `/issues/${issue.id}`, {status: 'in-progress'})
    await api(request, 'post', `/issues/${issue.id}/comments`, {body: 'Two columns off.'})
})

test.afterAll(async ({request}) => {
    await request.patch('/api/settings', {data: {advanced}, headers: OWNER})
})

test('keeps to a family of kinds or to one kind', async ({page}) => {
    await page.goto('/events?project=ledger')
    const lines = page.getByRole('log').locator('div')
    await expect(lines.filter({hasText: 'issue.created'})).not.toHaveCount(0)
    await expect(lines.filter({hasText: 'comment.added'})).not.toHaveCount(0)

    // A family: every issue.* and nothing else.
    await page.getByRole('button', {name: 'Kind'}).click()
    await page.getByRole('option', {name: 'issue.* (all)'}).click()
    await expect(page).toHaveURL(/kind=issue(&|$)/)
    await expect(lines.filter({hasText: 'issue.status'})).not.toHaveCount(0)
    await expect(lines.filter({hasText: 'issue.created'})).not.toHaveCount(0)
    await expect(lines.filter({hasText: 'comment.added'})).toHaveCount(0)

    // One kind, still in the project, after a reload too.
    await page.getByRole('button', {name: 'Kind'}).click()
    await page.getByRole('option', {name: 'issue.status', exact: true}).click()
    await expect(page).toHaveURL(/kind=issue\.status/)
    await page.reload()
    await expect(page.getByRole('button', {name: 'Kind'})).toHaveText('issue.status')
    await expect(lines.filter({hasText: 'issue.status'})).not.toHaveCount(0)
    await expect(lines.filter({hasText: 'issue.created'})).toHaveCount(0)
    expect(new URL(page.url()).searchParams.get('project')).toBe('ledger')

    // None of a kind says which.
    await page.goto('/events?project=ledger&kind=backup.made')
    await expect(page.getByText('Nothing logged of backup.made in Ledger yet.')).toBeVisible()
})

test("an issue event's line links the issue, and following it opens the issue", async ({page, request}) => {
    const issue = await api(request, 'post', '/issues', {title: 'Carry the one'})
    await page.goto('/events?project=ledger')
    const line = page.getByRole('log').locator('div').filter({hasText: new RegExp(`issue\\.created.*made ${issue.id}`)})
    await expect(line).toBeVisible()
    // Made by an agent: the line names it as the page does, not by its stored actor (ORR-477).
    await expect(line).toContainText(`Agent made ${issue.id}`)
    await expect(line).not.toContainText('claude')
    await expect(line.getByRole('link', {name: '[ledger]'})).toHaveAttribute('href', '/p/ledger')
    const link = line.getByRole('link', {name: issue.id})
    await expect(link).toHaveAttribute('href', `/p/ledger/issues/${issue.id}`)

    // Clicking the line opens nothing under it: it's one line still, with no actions.
    const height = (await line.boundingBox())!.height
    await line.click({position: {x: 5, y: 5}})
    expect((await line.boundingBox())!.height).toBe(height)
    await expect(page.getByRole('button', {name: 'Resolve'})).toHaveCount(0)
    await link.click()
    await expect(page).toHaveURL(new RegExp(`/p/ledger/issues/${issue.id}$`))
    await expect(page.getByText('Carry the one').first()).toBeVisible()
})

test('an error an agent resolved stays on the bell, and says who resolved it', async ({page, request}) => {
    // When the owner last looked, as a tab that has looked keeps it, so a reload counts from then.
    const looked = new Date().toISOString()
    await page.addInitScript(at => localStorage.setItem('orrery-events-seen', at), looked)
    await page.goto('/p/ledger')
    const bell = page.locator('a[href="/notifications"]').first()
    const errors = async () => Number(/(\d+) new kinds? of error/.exec(await bell.getAttribute('aria-label') ?? '')?.[1] ?? 0)
    const before = await errors()
    const message = `ledger broke ${Date.now()}`
    const logged = await request.post('/api/events/log', {data: {message, page: '/p/ledger'}})
    expect(logged.status(), await logged.text()).toBe(201)
    const event = await logged.json()
    expect(event.details).toMatchObject({reported: true})
    await expect.poll(errors).toBe(before + 1)

    const resolved = await request.post(`/api/events/log/${event.id}/resolve`, {headers: {'Orrery-Actor': 'claude'}})
    expect(await resolved.json()).toMatchObject({resolved_by: 'claude'})
    await page.reload()
    await expect.poll(errors).toBe(before + 1)
    await page.goto(`/events?kind=page.error`)
    await expect(page.getByRole('log').locator('div').filter({hasText: message})).toContainText('(resolved by Agent)')
})

test("takes only a few of the page's reports of a kind a minute", async ({request}) => {
    const kind = `page.flood${Date.now()}`
    const sent = []
    for (let i = 0; i < 6; i++) sent.push((await request.post('/api/events/log', {data: {message: `flood ${i}`, kind}})).status())
    expect(sent).toEqual([201, 201, 201, 201, 201, 429])
})

test("counts each sender's reports apart, so a script can't use up the page's (ORR-457)", async ({request}) => {
    const script = {'Orrery-Actor': `script${Date.now()}`}
    const sent = []
    for (let i = 0; i < 21; i++) sent.push((await request.post('/api/events/log', {headers: script, data: {message: `noise ${i}`, kind: `page.noise${i}`}})).status())
    expect(sent.slice(0, 20).every(s => s === 201)).toBe(true)
    expect(sent[20]).toBe(429)
    // Another name from the same place gets no new allowance (ORR-483).
    const renamed = await request.post('/api/events/log', {headers: {'Orrery-Actor': `other${Date.now()}`}, data: {message: 'more noise', kind: 'page.noise-renamed'}})
    expect(renamed.status()).toBe(429)
    const page = await request.post('/api/events/log', {data: {message: `the page's own ${Date.now()}`}})
    expect(page.status(), await page.text()).toBe(201)
})
