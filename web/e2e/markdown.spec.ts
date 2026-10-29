import {expect, test} from '@playwright/test'
import {makeProject, projectApi} from './support'

// What an agent or an outside contributor writes in an issue's notes or a comment is drawn as Markdown, cleaned
// (app/utils/markdown.ts, ORR-582). Tried in the browser, as happy-dom's DOM lets DOMPurify hand a script back as it
// came: nothing that runs gets onto the page, links to the web open apart, and headings' ids can't name anything on it.
test.describe.configure({mode: 'serial'})

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

test("gives headings ids of their own that can't name anything on the page", async ({page, request}) => {
    const issue = await api(request, 'post', '/issues', {title: 'Shelves', notes: '## location\n\none\n\n## Jam\n\ntwo\n\n## Jam\n\nthree\n\n## !!!'})
    await page.goto(`/p/pantry-notes/issues/${issue.id}`)
    await expect(page.locator('.doc h2')).toHaveCount(4)
    expect(await page.locator('.doc h2').evaluateAll(hs => hs.map(h => h.id))).toEqual(['h-location', 'h-jam', 'h-jam-2', 'h-section'])
    // A heading named for something on window doesn't take its place.
    expect(await page.evaluate(() => typeof window.location.href)).toBe('string')
})
