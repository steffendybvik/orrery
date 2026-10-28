import {expect, test} from '@playwright/test'
import {OWNER} from './support'

// App settings says where this Orrery keeps its data (ORR-284), and how big it is (ORR-323): the SQLite file, or the Postgres database the
// run is on (E2E_POSTGRES_URL), never with its password. CI's password is `orrery`, also in the user and database
// names, so the checks look for it as `:password@`, the way a URL would carry it.
test('App settings shows where the data is, without a password', async ({page, request}) => {
    if (!(await (await request.get('/api/owner')).json()).named) await request.put('/api/owner', {data: {name: 'Ada Lovelace'}})
    const {database} = await (await request.get('/api/settings')).json()
    const postgres = process.env.E2E_POSTGRES_URL
    expect(database.size).toBeGreaterThan(0)
    if (postgres) {
        const url = new URL(postgres)
        expect(database).toMatchObject({kind: 'postgres', where: `${url.username}@${url.host}${url.pathname}`})
        expect(JSON.stringify(database)).not.toContain(`:${url.password}@`)
    } else {
        expect(database.kind).toBe('sqlite')
        expect(database.where).toMatch(/\/\.data\/e2e\.db$/)
    }

    await page.goto('/settings#database')
    const section = page.locator('#database')
    await expect(section.getByRole('heading', {name: 'Database'})).toBeVisible()
    await expect(section).toContainText(database.where)
    await expect(section.getByText('Size')).toBeVisible()
    if (postgres) await expect(section).not.toContainText(`:${new URL(postgres).password}@`)
})

// Moving to another SQLite file from App settings (ORR-292): checked, copied, run on at once, then moved back as it was,
// so the files after this one run where they did. On Postgres (set as it starts) it's moved where it's set, not here.
test('moves the data to another database from App settings, and back', async ({page, request}) => {
    test.skip(!!process.env.E2E_POSTGRES_URL, 'ORRERY_DATABASE names Postgres, so the database is changed where it is set')
    const {database: before} = await (await request.get('/api/settings')).json()
    const projects = (await (await request.get('/api/projects')).json()).length
    const file = `e2e-moved-${Date.now()}.db`
    try {
        await page.goto('/settings#database')
        const section = page.locator('#database')
        await section.getByRole('button', {name: 'Move to another database…'}).click()
        await section.getByRole('radio', {name: 'SQLite file'}).click()
        await section.getByRole('textbox', {name: 'SQLite file'}).fill(file)
        await section.getByRole('button', {name: 'Check it'}).click()
        await expect(section).toContainText('Empty')
        await section.getByRole('button', {name: 'Copy and move'}).click()
        // It loads again on the database it moved to, with everything in it.
        await expect(section).toContainText(file)
        const {database: after} = await (await request.get('/api/settings')).json()
        expect(after).toMatchObject({kind: 'sqlite', moved: true})
        expect(after.where).toMatch(new RegExp(`/${file}$`))
        expect((await (await request.get('/api/projects')).json()).length).toBe(projects)
    } finally {
        const back = await request.post('/api/database/move', {headers: OWNER, data: {kind: 'sqlite', path: before.where, how: 'use'}})
        expect(back.ok()).toBe(true)
    }
    expect((await (await request.get('/api/settings')).json()).database).toMatchObject({where: before.where})
})
