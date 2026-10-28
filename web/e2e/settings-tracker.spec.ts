import {expect, test} from '@playwright/test'
import {OWNER} from './support'

// The team tracker's field takes a link to the tracker's projects page, as an owner pastes one, and saves it as the
// link to a task (ORR-404); another link without {id} is refused there and then. It's set back to none after.
test("saves a pasted link to the tracker's projects page as its task link", async ({page, request}) => {
    try {
        await page.goto('/settings?tab=issues#tracker')
        const field = page.getByRole('textbox', {name: 'Team tracker'})
        await field.fill('https://tracker.example.com/projects')
        await field.blur()
        await expect(page.getByText('opens the same page for every task')).toBeVisible()

        await field.fill('https://linear.app/acme/team/ENG/projects/all')
        await field.blur()
        await expect(page.getByRole('status')).toContainText('https://linear.app/acme/issue/{id}')
        await expect(field).toHaveValue('https://linear.app/acme/issue/{id}')
        expect((await (await request.get('/api/settings')).json()).tracker).toBe('https://linear.app/acme/issue/{id}')
    } finally {
        await request.patch('/api/settings', {data: {tracker: null}, headers: OWNER})
    }
})
