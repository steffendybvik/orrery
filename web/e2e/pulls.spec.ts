import {expect, test} from '@playwright/test'
import {OWNER, makeProject} from './support'

// The Pull requests page's Poll (ORR-534): GitHub asked at once, and a repo read without a token a moment ago held back,
// saying when it can be asked again. Whatever GitHub answers for the made-up repo, the second ask is held: for being
// read a moment ago, or, when CI's address has used up GitHub's rate limit, until it resets (ORR-566). (Whether the
// first polls depends on the background poll's timing; the unit tests cover that.)
const HELD = /^(Read without a token a moment ago|GitHub's rate limit is used up)/
test('polls now on Poll, and holds a repo without a token for five minutes', async ({page, request}) => {
    await makeProject(request, {name: 'Granary', key: 'GRN'})
    const set = await request.patch('/api/projects/granary', {data: {repo: 'https://github.com/orrery-e2e/granary'}, headers: OWNER})
    expect(set.ok(), await set.text()).toBeTruthy()
    await page.goto('/pulls')
    const pollButton = page.getByRole('button', {name: 'Poll', exact: true})
    await expect(pollButton).toBeEnabled()
    type Polled = {repos: {repo: string, held?: string}[]}
    const granary = (answer: Polled) => answer.repos.find(r => r.repo === 'orrery-e2e/granary')
    const polled = page.waitForResponse(r => r.url().includes('/api/pulls/poll'), {timeout: 20_000})
    await pollButton.click()
    expect(granary(await (await polled).json() as Polled)).toBeDefined()
    await expect(pollButton).toBeEnabled({timeout: 20_000})
    const again = page.waitForResponse(r => r.url().includes('/api/pulls/poll'))
    await pollButton.click()
    expect(granary(await (await again).json() as Polled)?.held).toMatch(HELD)
    await expect(page.getByRole('list', {name: 'Repos'})).toContainText(/not polled now: (Read without a token a moment ago|GitHub's rate limit is used up)/)
    // A repo GitHub couldn't be read for isn't counted as having none open (ORR-552): made up, these all fail.
    const {repos} = await (await request.get('/api/pulls')).json() as {repos: {repo: string, error?: string}[]}
    if (repos.every(r => r.error)) await expect(page.getByText("Couldn't read GitHub", {exact: true})).toBeVisible()
    // Each repo is its own card (ORR-603), and one that couldn't be read says so in it.
    const card = page.getByRole('list', {name: 'Repos'}).getByRole('listitem').filter({hasText: 'orrery-e2e/granary'})
    await expect(card.getByRole('link', {name: 'orrery-e2e/granary'})).toHaveAttribute('href', 'https://github.com/orrery-e2e/granary/pulls')
    if (repos.find(r => r.repo === 'orrery-e2e/granary')?.error) await expect(card).toContainText('not read')
    await expect(page.getByText('None open', {exact: true})).toHaveCount(repos.some(r => r.error) ? 0 : 1)
    // A repo no project is on isn't polled.
    expect((await request.post('/api/pulls/poll?repo=orrery-e2e/nowhere', {headers: OWNER})).status()).toBe(404)
    // Only the owner polls.
    expect((await request.post('/api/pulls/poll', {headers: {'Orrery-Actor': 'claude'}})).status()).toBe(403)
})

test('Branches lists what to do with each, and removes one only after asking (ORR-793)', async ({page, request}) => {
    const branch = (name: string, verdict: string, why: string, over: object = {}) => ({repo: 'orrery-e2e/silo', name, sha: 'abcdef1234', committed_at: '2026-10-01T00:00:00.000Z', ahead: 2, verdict, why, ...over})
    let removed = ''
    await page.route('**/api/pulls/branches**', route => {
        if (route.request().method() === 'DELETE') {
            removed = new URL(route.request().url()).searchParams.get('name') ?? ''
            return route.fulfill({status: 204})
        }
        return route.fulfill({json: {repos: [{repo: 'orrery-e2e/silo', projects: ['silo'], base: 'main', token: true}], branches: [
            branch('spike', 'look', 'It has no pull request'),
            branch('fix/done', 'remove', 'Its pull request merged', {pull: {number: 4, url: 'https://github.com/orrery-e2e/silo/pull/4', state: 'merged'}}),
            branch('main', 'keep', 'The default branch, or a release being prepared', {ahead: 0}),
        ].filter(b => b.name !== removed)}})
    })
    await page.goto('/pulls')
    await page.getByRole('link', {name: 'Branches'}).click()
    await expect(page).toHaveURL(/view=branches/)
    await expect(page.getByText('3 branches: 1 to look at, 1 to remove, 1 to keep')).toBeVisible()
    const row = page.getByRole('listitem').filter({hasText: 'fix/done'}).last()
    await expect(row).toContainText('(a squash merge leaves them reading so)')
    // Only what reads as remove offers it, and it asks first.
    await expect(page.getByRole('button', {name: 'Remove…'})).toHaveCount(1)
    await row.getByRole('button', {name: 'Remove…'}).click()
    expect(removed).toBe('')
    await row.getByRole('button', {name: /Remove|Yes|Confirm/}).last().click()
    await expect(page.getByText('2 branches: 1 to look at, 0 to remove, 1 to keep')).toBeVisible()
    expect(removed).toBe('fix/done')
    // Its reads and removal are the owner's alone.
    expect((await request.get('/api/pulls/branches', {headers: {'Orrery-Actor': 'claude'}})).status()).toBe(403)
    expect((await request.delete('/api/pulls/branches?repo=a/b&name=c', {headers: {'Orrery-Actor': 'claude'}})).status()).toBe(403)
    expect((await request.get('/api/pulls/branches', {headers: OWNER})).ok()).toBe(true)
})

// What GitHub would answer is made up here, so the page's rows can be every state whatever GitHub says.
test('lists where each pull request stands, and Focus on this sends the note it fills in', async ({page, request}) => {
    await makeProject(request, {name: 'Silo', key: 'SIL'})
    const made = await request.post('/api/projects/silo/issues', {data: {title: 'Patch the roof'}, headers: OWNER})
    const issue = await made.json()
    const pull = (number: number, state: string, title: string, named: boolean) => ({
        number, title, state, repo: 'orrery-e2e/silo', url: `https://github.com/orrery-e2e/silo/pull/${number}`, branch: `fix/${number}`, base: 'main', author: 'ada',
        created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
        ...named ? {issue: {project: 'silo', id: issue.id, title: 'Patch the roof'}} : {},
    })
    await page.route(/\/api\/pulls\?/, route => route.fulfill({json: {
        pulls: [pull(11, 'conflicting', 'Mend the eaves', true), pull(12, 'ready', 'Tar the seams', false)],
        open: 2, needs: 1, page: 1, limit: 50,
        repos: [{repo: 'orrery-e2e/silo', projects: ['silo'], token: true, open: 2, needs: 1}],
    }}))
    await page.goto('/pulls')
    const rows = page.getByRole('list', {name: 'Open pull requests on orrery-e2e/silo'}).getByRole('listitem')
    const conflicting = rows.filter({hasText: 'Mend the eaves'})
    const ready = rows.filter({hasText: 'Tar the seams'})
    await expect(conflicting).toContainText('Conflicts')
    await expect(ready).toContainText('Ready to merge')
    // One naming no issue has none to focus.
    await expect(ready).toContainText('no issue')
    await expect(ready.getByRole('button', {name: 'Focus on this'})).toHaveCount(0)
    await conflicting.getByRole('button', {name: 'Focus on this'}).click()
    const note = page.getByRole('textbox', {name: 'Note'})
    await expect(note).toHaveValue(/#11 .*conflicts with main/)
    await note.fill('Mind the ladder')
    await page.getByRole('button', {name: 'Send', exact: true}).click()
    await expect(conflicting.getByRole('button', {name: /^Sent/})).toBeVisible()
    const signals = await (await request.get(`/api/projects/silo/signals`)).json() as {note?: string}[]
    expect(signals.map(signal => signal.note)).toContain('Mind the ladder')
})

test("opens a pull request by its number, listing every issue it's linked to (ORR-880)", async ({page, request}) => {
    await makeProject(request, {name: 'Hayloft', key: 'HAY'})
    const issues = await Promise.all(['Muck out', 'Mend the gate'].map(async title => (await (await request.post('/api/projects/hayloft/issues', {data: {title}, headers: OWNER})).json()).id as string))
    await page.route(/\/api\/pulls\?/, route => route.fulfill({json: {
        pulls: [{number: 21, title: 'Spring clean', state: 'ready', repo: 'orrery-e2e/hayloft', url: 'https://github.com/orrery-e2e/hayloft/pull/21', branch: 'feat/21', base: 'main', author: 'ada',
            created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', issue: {project: 'hayloft', id: issues[0], title: 'Muck out'}}],
        open: 1, needs: 0, page: 1, limit: 50, repos: [{repo: 'orrery-e2e/hayloft', projects: ['hayloft'], token: true, open: 1, needs: 0}],
    }}))
    // orrery keeps a PR once a poll finds it naming an issue, so the page's answer is stood in for here; the store's is unit tested.
    await page.route('**/api/pulls/orrery-e2e/hayloft/21', route => route.fulfill({json: {
        repo: 'orrery-e2e/hayloft',
        pull: {number: 21, title: 'Spring clean', url: 'https://github.com/orrery-e2e/hayloft/pull/21', branch: 'feat/21', base: 'main', author: 'ada', state: 'merged', merged_at: '2026-10-02T00:00:00.000Z', updated_at: '2026-10-02T00:00:00.000Z'},
        issues: issues.map((id, i) => ({project: 'hayloft', project_name: 'Hayloft', id, title: ['Muck out', 'Mend the gate'][i], status: 'todo'})),
    }}))
    await page.goto('/pulls')
    await page.getByRole('link', {name: '#21', exact: true}).click()
    await expect(page).toHaveURL(/\/pulls\/orrery-e2e\/hayloft\/21$/)
    await expect(page.getByRole('heading', {name: '#21 Spring clean'})).toBeVisible()
    await expect(page.getByRole('region', {name: 'The pull request'})).toContainText('Merged')
    const linked = page.getByRole('list', {name: 'Linked issues'}).getByRole('listitem')
    await expect(linked).toHaveCount(2)
    await linked.filter({hasText: 'Mend the gate'}).getByRole('link').click()
    await expect(page).toHaveURL(new RegExp(`/p/hayloft/issues/${issues[1]}$`))
    // Its address opens it straight away too.
    await page.goto('/pulls/orrery-e2e/hayloft/21')
    await expect(page.getByRole('heading', {name: '#21 Spring clean'})).toBeVisible()
    // ⌘K opens it by its number, on the page's project's repo, or by its link from anywhere.
    await request.patch('/api/projects/hayloft', {data: {repo: 'https://github.com/orrery-e2e/hayloft'}, headers: OWNER}).then(r => expect(r.ok()).toBeTruthy())
    const palette = page.getByRole('dialog', {name: 'Commands'})
    for (const [from, heading, typed] of [['/p/hayloft', 'Hayloft', '#21'], ['/mine', 'My issues', 'https://github.com/orrery-e2e/hayloft/pull/21']]) {
        await page.goto(from!)
        await expect(page.getByRole('heading', {name: heading, exact: true}).first()).toBeVisible()
        await page.keyboard.press('ControlOrMeta+k')
        await palette.getByLabel('Type a command or search').fill(typed!)
        await expect(palette.getByRole('option', {name: /Pull request #21/})).toBeVisible()
        await page.keyboard.press('Enter')
        await expect(page.getByRole('heading', {name: '#21 Spring clean'})).toBeVisible()
    }
})

test("Send back, on an issue's page, sends what its pull request needs", async ({page, request}) => {
    await makeProject(request, {name: 'Byre', key: 'BYR'})
    const issue = await (await request.post('/api/projects/byre/issues', {data: {title: 'Lime the walls'}, headers: OWNER})).json()
    const pull = {
        number: 21, title: 'Lime the walls', state: 'conflicting', repo: 'orrery-e2e/byre', url: 'https://github.com/orrery-e2e/byre/pull/21', branch: 'fix/21', base: 'main', author: 'ada',
        created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
    }
    await page.route(`**/api/projects/byre/issues/${issue.id}/pulls`, route => route.fulfill({json: {repo: 'orrery-e2e/byre', pulls: [pull]}}))
    await page.goto(`/p/byre/issues/${issue.id}`)
    const pulls = page.getByRole('region', {name: 'Pull requests'})
    await expect(pulls).toContainText('Conflicts')
    await pulls.getByRole('button', {name: 'Send back'}).click()
    await expect(pulls.getByText('Sent', {exact: true})).toBeVisible()
    const signals = await (await request.get('/api/projects/byre/signals')).json() as {note?: string}[]
    expect(signals.map(signal => signal.note).join()).toMatch(/#21 .*conflicts with main/)
})

test("shows each pull request's risk on an issue's page, the riskiest in the heading (ORR-879)", async ({page, request}) => {
    await makeProject(request, {name: 'Shed', key: 'SHD'})
    const issue = await (await request.post('/api/projects/shed/issues', {data: {title: 'New roof'}, headers: OWNER})).json()
    const at = '2026-10-01T00:00:00.000Z'
    const pull = {number: 31, title: 'Roof felt', state: 'ready', url: 'https://github.com/orrery-e2e/shed/pull/31', branch: 'feat/31', base: 'main', author: 'ada', created_at: at, updated_at: at,
        risk: {level: 'medium', why: 'medium: changes how the roof page saves', by: 'session'}}
    const done = {number: 30, title: 'Gutter copy', state: 'merged', url: 'https://github.com/orrery-e2e/shed/pull/30', branch: 'docs/30', base: 'main', author: 'ada', merged_at: at, updated_at: at,
        risk: {level: 'low', why: 'low: copy only', by: 'owner'}}
    await page.route(`**/api/projects/shed/issues/${issue.id}/pulls`, route => route.fulfill({json: {repo: 'orrery-e2e/shed', pulls: [pull], done: [done], token: true, checked_at: at}}))
    await page.goto(`/p/shed/issues/${issue.id}`)
    const pulls = page.getByRole('region', {name: 'Pull requests'})
    await expect(pulls.getByRole('heading').getByText('Medium risk')).toBeVisible()
    const open = pulls.getByRole('listitem').filter({hasText: 'Roof felt'})
    await expect(open.getByText('Medium risk')).toHaveAttribute('title', 'medium: changes how the roof page saves (rated by the session that opened it)')
    await expect(open).toContainText('changes how the roof page saves')
    await expect(pulls.getByRole('listitem').filter({hasText: 'Gutter copy'}).getByText('Low risk')).toHaveAttribute('title', /rated by you/)
})
