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
