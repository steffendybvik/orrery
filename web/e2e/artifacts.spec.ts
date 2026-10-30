import {expect, test} from '@playwright/test'
import {AGENT, makeProject} from './support'

// An artifact is drawn on its doc's page, styled with Tailwind and the app's theme, and locked down (ORR-677). Only a real
// browser enforces the sandbox and the CSP, so this is where that's shown: its script runs and reports what it could do.
test.describe.configure({mode: 'serial'})

const put = async (request: import('@playwright/test').APIRequestContext, id: string, title: string, body: string) =>
    expect((await request.put(`/api/projects/atelier/docs/${id}`, {data: {title, body, kind: 'artifact'}, headers: AGENT})).ok()).toBeTruthy()

test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Atelier', key: 'ATL'})
})

const TRIES = `<pre id="out">waiting</pre><script>
(async () => {
    const out = {ran: true}
    const attempt = async (name, work) => {
        try { out[name] = await work() } catch { out[name] = 'blocked' }
    }
    await attempt('api', async () => (await fetch('/api/sentinel-fetch')).status)
    await attempt('parent', () => parent.document.title)
    await attempt('storage', () => localStorage.length)
    await attempt('cookie', () => document.cookie)
    await attempt('popup', () => window.open('about:blank') ? 'opened' : 'blocked')
    await attempt('top', () => { top.location = '/sentinel-top'; return 'asked' })
    await attempt('form', () => {
        const form = document.createElement('form')
        form.method = 'post'
        form.action = '/api/sentinel-form'
        document.body.append(form)
        form.submit()
        return 'asked'
    })
    await attempt('image', () => new Promise(done => {
        const image = new Image()
        image.onload = () => done('loaded')
        image.onerror = () => done('blocked')
        image.src = '/api/sentinel-image'
    }))
    await attempt('origin', () => origin)
    document.getElementById('out').textContent = JSON.stringify(out)
})()
</script>`

test("runs its script, which can't reach the app, the network, a popup, a form or the top tab", async ({page, request, browserName}) => {
    await put(request, 'tries', 'Tries', TRIES)
    // The browser reports a blocked image as a request that failed, so what counts is that none was answered.
    const answered: string[] = []
    page.on('response', r => {
        if (r.url().includes('sentinel')) answered.push(r.url())
    })
    const failed: string[] = []
    page.on('requestfailed', r => {
        if (r.url().includes('sentinel')) failed.push(`${new URL(r.url()).pathname} ${r.failure()?.errorText}`)
    })
    let popups = 0
    page.on('popup', () => popups++)
    await page.goto('/p/atelier/docs/tries')
    const frame = page.frameLocator('iframe[title="Artifact"]')
    await expect(frame.locator('#out')).toContainText('"ran":true')
    const out = JSON.parse(await frame.locator('#out').textContent() ?? '{}') as Record<string, unknown>
    expect(out).toMatchObject({api: 'blocked', parent: 'blocked', storage: 'blocked', cookie: 'blocked', popup: 'blocked', image: 'blocked', origin: 'null'})
    await expect(page).toHaveURL(/\/p\/atelier\/docs\/tries$/)
    expect(answered).toEqual([])
    // Only Chrome reports it this way: the others don't report a blocked image as a request at all.
    if (browserName === 'chromium') expect(failed).toEqual(['/api/sentinel-image csp'])
    expect(popups).toBe(0)
    await expect(page.locator('iframe[title="Artifact"]')).toHaveAttribute('sandbox', 'allow-scripts')
})

test('is locked down in a tab of its own too', async ({page, request}) => {
    // In its own tab it is the top, so it may navigate itself: what it can't do is reach anything.
    await put(request, 'alone', 'Alone', `<pre id="out">waiting</pre><script>
        fetch('/api/sentinel-fetch').then(() => 'reached', () => 'blocked').then(api => {
            let storage = 'blocked'
            try { storage = String(localStorage.length) } catch {}
            document.getElementById('out').textContent = JSON.stringify({api, storage, origin})
        })
    </script>`)
    const answered: string[] = []
    page.on('response', r => {
        if (r.url().includes('sentinel')) answered.push(r.url())
    })
    const answer = await page.goto('/api/projects/atelier/docs/alone/artifact')
    const headers = answer!.headers()
    expect(headers['content-security-policy']).toContain('sandbox allow-scripts')
    expect(headers['x-content-type-options']).toBe('nosniff')
    await expect(page.locator('#out')).toHaveText('{"api":"blocked","storage":"blocked","origin":"null"}')
    expect(answered).toEqual([])
})

test("draws Tailwind's classes and the app's theme, and follows dark mode", async ({page, request}) => {
    await put(request, 'styled', 'Styled', '<div id="box" class="bg-accent-500 p-4 text-fg dark:bg-fg">Styled</div>')
    await page.goto('/p/atelier/docs/styled')
    await page.evaluate(() => {
        localStorage.setItem('orrery-theme', 'light')
    })
    await page.reload()
    const box = page.frameLocator('iframe[title="Artifact"]').locator('#box')
    await expect(box).toHaveCSS('padding-top', '16px')
    const light = await box.evaluate(el => getComputedStyle(el).backgroundColor)
    expect(light).toContain('oklch')

    // It follows as you switch, with no reload of the page.
    await page.getByRole('button', {name: 'Switch to dark'}).click()
    await expect(page.locator('html')).toHaveClass(/dark/)
    await expect(box).toHaveCSS('padding-top', '16px')
    // Switching replaces the frame, so these retry a read that finds the old one going.
    await expect(box).not.toHaveCSS('background-color', light)
    await page.getByRole('button', {name: 'Switch to light'}).click()
    await expect(box).toHaveCSS('background-color', light)
    await page.evaluate(() => {
        localStorage.removeItem('orrery-theme')
    })
})

test('takes a whole document of its own', async ({page, request}) => {
    await put(request, 'whole', 'Whole', '<!doctype html><html><head><title>Mine</title><style>#own { margin-top: 7px }</style></head><body><div id="own" class="p-2">Own</div></body></html>')
    await page.goto('/p/atelier/docs/whole')
    const own = page.frameLocator('iframe[title="Artifact"]').locator('#own')
    await expect(own).toHaveCSS('margin-top', '7px')
    await expect(own).toHaveCSS('padding-top', '8px')
})

test('keeps what it throws to itself, and the app keeps working', async ({page, request}) => {
    await put(request, 'boom', 'Boom', '<p id="before">Before</p><script>throw new Error("boom")</script>')
    await page.goto('/p/atelier/docs/boom')
    await expect(page.frameLocator('iframe[title="Artifact"]').locator('#before')).toBeVisible()
    await expect(page.getByRole('heading', {level: 1, name: 'Boom'})).toBeVisible()
    await page.getByRole('button', {name: 'Reload'}).click()
    await expect(page.frameLocator('iframe[title="Artifact"]').locator('#before')).toBeVisible()
    await page.getByRole('link', {name: 'Whole'}).click()
    await expect(page.getByRole('heading', {level: 1, name: 'Whole'})).toBeVisible()
})

test('says so when it fails to load, and Reload tries again', async ({page, request}) => {
    await put(request, 'fails', 'Fails', '<p id="fine">Fine</p>')
    await page.route('**/docs/fails/artifact*', route => route.fulfill({status: 500, body: 'no'}))
    await page.goto('/p/atelier/docs/fails')
    await expect(page.getByRole('alert')).toContainText('500')
    await expect(page.locator('iframe[title="Artifact"]')).toHaveCount(0)
    await page.unroute('**/docs/fails/artifact*')
    await page.getByRole('button', {name: 'Reload'}).click()
    await expect(page.frameLocator('iframe[title="Artifact"]').locator('#fine')).toBeVisible()
})

test('is made from the docs list, edited as text, and a Markdown doc is never served as a page', async ({page, request}) => {
    await page.goto('/p/atelier/docs')
    await page.getByRole('button', {name: 'New artifact'}).click()
    const dialog = page.getByRole('dialog', {name: 'New artifact'})
    await dialog.getByLabel('Title').fill('By hand')
    await dialog.getByLabel('Text').fill('<p id="made" class="p-3">Made</p>')
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(page).toHaveURL(/\/docs\/by-hand$/)
    await expect(page.frameLocator('iframe[title="Artifact"]').locator('#made')).toHaveCSS('padding-top', '12px')

    await page.getByRole('button', {name: 'Edit'}).click()
    await expect(page.getByLabel('Text')).toHaveValue('<p id="made" class="p-3">Made</p>')
    await page.getByLabel('Text').fill('<p id="made" class="p-3">Changed</p>')
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(page.frameLocator('iframe[title="Artifact"]').locator('#made')).toHaveText('Changed')

    await page.getByRole('button', {name: 'History'}).click()
    await expect(page.getByRole('region', {name: 'History'}).locator('[data-diff="added"]')).toContainText('Changed')

    await request.put('/api/projects/atelier/docs/plain', {data: {title: 'Plain', body: '<script>1</script>'}, headers: AGENT})
    expect((await request.get('/api/projects/atelier/docs/plain/artifact')).status()).toBe(404)
})
