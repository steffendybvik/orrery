import {readFileSync} from 'node:fs'
import {expect, test} from './test'
import {AGENT, makeProject} from './support'

// A board as one file (ORR-668): App settings saves what the API gives, named for the board (ORR-1248); its Settings
// links there with it picked.
test('downloads a board from App settings, as a file holding its issues', async ({page, request}) => {
    await makeProject(request, {name: 'Medlar', key: 'MED'})
    await request.post('/api/projects/medlar/issues', {data: {title: 'Graft the rootstock'}, headers: AGENT})
    await page.goto('/p/medlar/settings')
    await page.locator('#export').getByRole('link', {name: 'App settings'}).click()
    await expect(page.getByLabel('Project to export')).toHaveValue('medlar')
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', {name: 'Download the board'}).click()])
    expect(download.suggestedFilename()).toMatch(/^medlar-\d{4}-\d{2}-\d{2}\.orrery\.json$/)
    const board = JSON.parse(readFileSync(await download.path(), 'utf8'))
    expect(board).toMatchObject({format: 'orrery-board', project: 'medlar', uploads: [], tables: {issues: [{title: 'Graft the rootstock'}]}})
    expect((await request.get('/api/projects/nobody-here/export')).status()).toBe(404)
})
