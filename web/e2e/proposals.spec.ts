import {expect, test} from '@playwright/test'
import {makeProject, projectApi} from './support'

// An agent's proposal waits on the owner: Approve puts it on the roadmap, and their picks survive a live update.
test.describe.configure({mode: 'serial'})

const api = projectApi('orangery')

test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Orangery', key: 'ORA'})
})

test("an agent's proposal waits until the owner approves it", async ({page, request}) => {
    const proposal = await api(request, 'post', '/issues', {title: 'Plan from what expires soonest', proposal: 'pending'})
    expect(proposal).toMatchObject({column: 'proposed', assignee: 'ada_lovelace'})
    await page.goto(`/p/orangery/issues/${proposal.id}`)
    await page.getByRole('button', {name: 'Approve'}).click()
    // Approving puts it on the roadmap: committed, in Todo, keeping who approved it.
    await expect.poll(async () => (await api(request, 'get', `/issues/${proposal.id}`)).column).toBe('todo')
    const approved = await api(request, 'get', `/issues/${proposal.id}`)
    expect(approved.proposal).toBeFalsy()
    expect(approved.decided_by).toBe('ada_lovelace')
    expect((await api(request, 'get', `/issues/${proposal.id}/comments`)).at(-1)).toMatchObject({body: 'Approved this proposal.', created_by: 'ada_lovelace'})
})

test("the owner's picks on a proposal survive a live update before they approve", async ({page, request}) => {
    const choices = [{key: 'store', question: 'Where do the dates live?', pick: 'one', recommended: ['jar'], options: [{key: 'jar', title: 'On each jar'}, {key: 'sheet', title: 'On one sheet'}]}]
    const proposal = await api(request, 'post', '/issues', {title: 'Track expiry dates', proposal: 'pending', choices})
    const other = await api(request, 'post', '/issues', {title: 'Restock flour'})
    await page.goto(`/p/orangery/issues/${proposal.id}`)
    await page.getByLabel('On one sheet').check()
    // An agent's comment elsewhere in the project brings a new copy of the proposal down the live stream.
    await api(request, 'post', `/issues/${other.id}/comments`, {body: 'Ordered two bags'})
    await page.waitForTimeout(500)
    await expect(page.getByLabel('On one sheet')).toBeChecked()
    await page.getByRole('button', {name: 'Approve'}).click()
    await expect.poll(async () => (await api(request, 'get', `/issues/${proposal.id}`)).picks).toEqual({store: ['sheet']})
})
