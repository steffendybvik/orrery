import {expect, test} from '@playwright/test'
import {OWNER} from './support'

// The owner letting sessions out of work pick their next issue (ORR-452), on Sessions → Setup, and back off.
test('turns picking the next issue on and off from Sessions → Setup', async ({page, request}) => {
    await page.goto('/sessions?tab=setup')
    const pick = page.getByLabel('When a session runs out of work, it picks its next issue')
    await expect(pick).not.toBeChecked()
    await pick.check()
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).pick_next).toBe(true)
    await page.reload()
    await expect(pick).toBeChecked()
    await pick.uncheck()
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).pick_next).toBe(false)
    await request.patch('/api/settings', {data: {pick_next: false}, headers: OWNER})
})
