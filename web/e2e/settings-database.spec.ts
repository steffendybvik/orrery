import {existsSync, mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
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

// Backups set from App settings (ORR-320): the run has no NUXT_BACKUP_DIR, so a folder is given, backed up to at once,
// and then they're turned off again, as the files after this one expect. On Postgres they're set as it starts.
test('backs up to a folder chosen in App settings, and turns them off again', async ({page}) => {
    test.skip(!!process.env.E2E_POSTGRES_URL, 'ORRERY_DATABASE names Postgres, so the backups are set as it starts')
    const folder = mkdtempSync(join(tmpdir(), 'orrery-e2e-backups-'))
    await page.goto('/settings#database')
    const section = page.locator('#database')
    const backUp = section.getByRole('checkbox', {name: 'Back up this Orrery'})
    await expect(backUp).not.toBeChecked()
    await section.getByRole('textbox', {name: 'Backup folder'}).fill(folder)
    await section.getByRole('button', {name: 'Back up here'}).click()
    await expect(section).toContainText('Backed up to')
    await expect(backUp).toBeChecked()
    expect(existsSync(join(folder, 'orrery.db'))).toBe(true)
    // How often and how many daily copies (ORR-445), each kept as it's picked.
    await expect(section.getByRole('radio', {name: 'After a change'})).toBeChecked()
    await section.getByRole('radio', {name: 'Hourly'}).click()
    await section.getByRole('spinbutton', {name: 'Daily copies kept'}).fill('7')
    await section.getByRole('spinbutton', {name: 'Daily copies kept'}).press('Enter')
    await page.reload()
    await expect(section.getByRole('radio', {name: 'Hourly'})).toBeChecked()
    await expect(section.getByRole('spinbutton', {name: 'Daily copies kept'})).toHaveValue('7')
    await backUp.uncheck()
    await expect(section).not.toContainText('Backed up to')
    await expect(section.getByRole('textbox', {name: 'Backup folder'})).toHaveValue(folder)
})
