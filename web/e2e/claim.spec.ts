import {expect, test} from '@playwright/test'
import {OWNER} from './support'

// Claiming this orrery from App settings → You (ORR-832), on the machine it runs on, with no shell. One orrery serves
// every spec, so the keys it makes are revoked again at the end, leaving it unclaimed.
test.afterEach(async ({request}) => {
    const keys = await (await request.get('/api/keys', {headers: OWNER})).json() as {id: string, revoked_at?: string}[]
    for (const key of keys.filter(k => !k.revoked_at)) await request.delete(`/api/keys/${key.id}`, {headers: OWNER})
})

test('claims the orrery from App settings and hands over both keys once', async ({page, request}) => {
    await page.goto('/settings?tab=you')
    const section = page.locator('#claim')
    await expect(section.getByRole('heading', {name: 'Claim this orrery'})).toBeVisible()
    await section.getByRole('button', {name: 'Claim this orrery'}).click()

    await expect(section.getByText('Claimed, and this browser is signed in.')).toBeVisible()
    await expect(section.getByText(/^orrery_person_/)).toBeVisible()
    await expect(section.getByText(/^orrery_agent_/)).toBeVisible()
    await expect(section.getByText(/keys\.json/).first()).toBeVisible()

    const keys = await (await request.get('/api/keys', {headers: OWNER})).json() as {kind: string, revoked_at?: string}[]
    expect(keys.filter(k => !k.revoked_at).map(k => k.kind).sort()).toEqual(['agent', 'person'])

    // Claimed, it's gone once you're done, and a second claim is refused.
    await section.getByRole('button', {name: 'Done'}).click()
    await expect(page.locator('#claim')).toHaveCount(0)
    expect((await request.post('/api/auth/claim', {headers: OWNER})).status()).toBe(409)
})
