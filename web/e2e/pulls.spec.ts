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
