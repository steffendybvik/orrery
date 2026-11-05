import {expect, test} from './test'

// Open on your phone, in App settings → You (ORR-833), the command palette and Getting started (ORR-876). The browser
// specs' server is on loopback only, so it says how to give the phone a port of its own; where it's open, the unit tests
// (phone.test.ts) say which address it shows.
test("says how to open it on a phone while only this machine can", async ({page}) => {
    await page.goto('/settings?tab=you#phone')
    const section = page.locator('#phone')
    await expect(section.getByRole('heading', {name: 'Open on your phone'})).toBeVisible()
    await expect(section.getByText('Only this machine can open it now.')).toBeVisible()
    await expect(section.getByText('ORRERY_PHONE_PORT')).toBeVisible()
})

// Signed in, under it (ORR-838): each browser and phone with a login, to end a lost one. The browser specs' server has
// login off and nobody signed in, so it says so.
test('lists the logins, with none yet', async ({page}) => {
    await page.goto('/settings?tab=you#logins')
    const section = page.locator('#logins')
    await expect(section.getByRole('heading', {name: 'Signed in'})).toBeVisible()
    await expect(section.getByText('Nothing is signed in: no browser or phone has a login.')).toBeVisible()
})

// The code where people look (ORR-876): ⌘K → Open on your phone opens it in a dialog of its own.
test('opens from the command palette in a dialog', async ({page}) => {
    await page.goto('/mine')
    await expect(page.getByRole('heading', {level: 1}).first()).toBeVisible()
    await page.keyboard.press('ControlOrMeta+k')
    const palette = page.getByRole('dialog', {name: 'Commands'})
    await palette.getByLabel('Type a command or search').fill('Open on your phone')
    await palette.getByRole('option').filter({has: page.getByText('Open on your phone', {exact: true})}).click()
    const dialog = page.getByRole('dialog', {name: 'Open on your phone'})
    await expect(dialog.getByText('Only this machine can open it now.')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
})

// And as Getting started's last step, optional and out of the count, ticked once the QR code has signed a phone in.
test("is Getting started's optional last step, ticked once a phone is signed in", async ({page}) => {
    await page.goto('/getting-started')
    const step = page.locator('[data-step="phone"]')
    await expect(step.getByText('Open it on your phone')).toBeVisible()
    await expect(page.getByText(/^5 steps to a session/)).toBeVisible()
    await step.getByRole('button', {name: 'Show the code'}).click()
    await expect(step.getByText('Only this machine can open it now.')).toBeVisible()

    await page.route('**/api/logins', route => route.fulfill({json: [{id: 'a1', person: 'owner', name: 'Phone, signed in by QR code', expires_at: '2026-12-01T00:00:00Z'}]}))
    await page.goto('/getting-started')
    await expect(step.getByText('Open it on your phone')).toBeVisible()
    await expect(step.getByRole('button', {name: 'Show the code'})).toBeHidden()
})

// Where it's open, the Mac's Bonjour name leads (ORR-874), saying a phone that can't find it has the IPs under it. The
// specs' server can't be opened to the network, so this answers `GET /api/phone` as an open one on a Mac would.
test("leads with the Mac's .local name where it's open, the IPs under it", async ({page}) => {
    await page.route('**/api/phone', route => route.fulfill({json: {reach: 'network', docker: false, port: '19000', phone: false, addresses: [
        {url: 'http://steffens-mac.local:19000', from: 'machine', name: true},
        {url: 'http://192.168.178.90:19000', from: 'machine'},
    ]}}))
    await page.goto('/settings?tab=you#phone')
    const section = page.locator('#phone')
    await expect(section.getByRole('img', {name: 'QR code for http://steffens-mac.local:19000'})).toBeVisible()
    await expect(section.getByText("is this machine's name on the Wi-Fi")).toBeVisible()
    await section.getByRole('button', {name: 'Show the QR code for http://192.168.178.90:19000'}).click()
    await expect(section.getByRole('img', {name: 'QR code for http://192.168.178.90:19000'})).toBeVisible()
    await expect(section.getByText("is this machine's name on the Wi-Fi")).toBeHidden()
})
