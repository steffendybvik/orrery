import {type Page, expect, test} from '@playwright/test'
import {OWNER, makeProject} from './support'

// Two people on one machine (ORR-657), with login off: the owner adds someone, puts them on a board, and the page acts as
// them. One orrery serves every spec, so the person goes again at the end, back to one person, which shows none of it.
const NAME = 'Hati Lokason'
const ID = 'hati_lokason'

test.afterEach(async ({request}) => {
    await request.delete(`/api/people/${ID}`, {headers: OWNER})
})

/** Acts as `person`: the page reloads for it, so what comes next has to wait, or a `goto` is cut short by that. */
async function actAs(page: Page, person: string) {
    await Promise.all([page.waitForEvent('load'), page.getByRole('combobox', {name: 'Acting as'}).selectOption(person)])
}

test('claims, board members and acting as someone, and none of it with one person', async ({page, request}) => {
    await makeProject(request, {name: 'Sorrel', key: 'SOR'})
    const made = await (await request.post('/api/projects/sorrel/issues', {data: {title: 'Sow the bed'}, headers: OWNER})).json()

    // One person: nothing shows but the place to add someone.
    await page.goto(`/p/sorrel/issues/${made.id}`)
    await expect(page.getByRole('heading', {name: 'Sow the bed'})).toBeVisible()
    await expect(page.getByRole('button', {name: 'Claim'})).toHaveCount(0)
    await expect(page.getByRole('combobox', {name: 'Acting as'})).toHaveCount(0)

    await page.goto('/settings?tab=orrery#people')
    await page.getByRole('textbox', {name: 'Their name'}).fill(NAME)
    await page.getByRole('button', {name: 'Add a person'}).click()
    await expect(page.locator('#people').getByText(NAME)).toBeVisible()

    await page.goto('/p/sorrel/settings')
    await expect(page.locator('#members').getByText('holds it')).toBeVisible()
    await page.getByRole('combobox', {name: 'Who to add'}).selectOption(ID)
    await page.getByRole('button', {name: 'Add to this board'}).click()
    await expect(page.locator('#members').getByText(NAME)).toBeVisible()

    // Assigned to them, so they can claim it, and it shows who holds it, on the page and on the list.
    await request.patch(`/api/projects/sorrel/issues/${made.id}`, {data: {assignee: ID}, headers: OWNER})
    await actAs(page, ID)
    await expect(page.getByRole('combobox', {name: 'Acting as'})).toHaveValue(ID)
    await page.goto(`/p/sorrel/issues/${made.id}`)
    await page.getByRole('button', {name: 'Claim'}).click()
    await expect(page.getByText(`Held by ${NAME}`).filter({visible: true}).first()).toBeVisible()
    await expect(page.getByText('took it up')).toBeVisible()
    await page.getByRole('button', {name: 'Let go'}).click()
    await expect(page.getByText("Nobody's taken it up").filter({visible: true}).first()).toBeVisible()
    await page.getByRole('button', {name: 'Claim'}).click()
    await expect(page.getByText(`Held by ${NAME}`).filter({visible: true}).first()).toBeVisible()
    await page.screenshot({path: process.env.SHOTS ? `${process.env.SHOTS}/claim-issue.png` : undefined})
    await page.goto('/p/sorrel')
    await expect(page.getByLabel(new RegExp(`^Held by ${NAME}`)).filter({visible: true}).first()).toBeVisible()
    await page.screenshot({path: process.env.SHOTS ? `${process.env.SHOTS}/claim-list.png` : undefined})
    await page.goto('/p/sorrel/settings')
    await page.locator('#members').scrollIntoViewIfNeeded()
    await page.screenshot({path: process.env.SHOTS ? `${process.env.SHOTS}/claim-members.png` : undefined})

    // The owner takes it over.
    await actAs(page, 'ada_lovelace')
    await expect(page.getByRole('combobox', {name: 'Acting as'})).toHaveValue('ada_lovelace')
    await page.goto(`/p/sorrel/issues/${made.id}`)
    await page.getByRole('button', {name: 'Take over'}).click()
    await expect(page.getByText(`took it over from`)).toBeVisible()
    expect((await (await request.get(`/api/projects/sorrel/issues/${made.id}`)).json()).assignee).toBe('ada_lovelace')
})
