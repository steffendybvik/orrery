import {describe, expect, it} from 'vitest'
import {TABLES, copy} from '../scripts/copy'
import {SqliteDb} from '../server/utils/database'
import {openDb} from '../server/utils/db'
import {Secrets} from '../server/utils/secrets'
import {Store} from '../server/utils/store'
import {testDb} from './db'

/** A 1×1 PNG, base64. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

/** The secrets of an Orrery, under one key; their calls all answer 200. */
const secretsOf = (store: Store) => new Secrets(store, () => 'a long random test key', () => {}, (async () => new Response('{}')) as typeof fetch)

/** An Orrery with a bit of everything in it. */
async function filled() {
    const store = new Store(new SqliteDb(openDb(':memory:')))
    const owner = {name: 'skoll', owner: true}
    await store.nameOwner({name: 'Skoll'})
    await store.createProject({name: 'Larder', key: 'LAR'}, owner)
    await store.createChunk('larder', {title: 'Shelves'})
    const parent = await store.createIssue('larder', {title: 'Shelf labels', chunk: '1', status: 'todo'}, owner)
    const child = await store.createIssue('larder', {title: 'Print them', parent: parent.id, status: 'started'})
    await store.createComment('larder', child.id, {body: 'Which printer?', asks: 'decision'})
    await store.createComment('larder', child.id, {body: 'The office one'}, owner)
    await store.createStatus({name: 'Blocked', kind: 'started', color: 'rose'}, owner)
    await store.putDoc('larder', 'readme', {title: 'Readme', body: '# Larder'})
    await store.focus('larder', child.id, {session: 'window-a'}, owner)
    await store.updateSettings({tint: 'teal'}, owner)
    await secretsOf(store).set('STRIPE_KEY', {value: 'sk_live_abcdef123456', hosts: ['api.stripe.com']}, owner)
    await secretsOf(store).egress({url: 'https://api.stripe.com/v1/charges', headers: {Authorization: 'Bearer {{secret:STRIPE_KEY}}'}})
    await store.createUpload({data: PNG, name: 'shelf.png'}, owner)
    return store
}

const everything = async (store: Store) => ({
    projects: await store.listBoards(), statuses: await store.statuses(), settings: await store.settings(), owner: await store.ownerOf(),
    comments: await store.listComments('larder', 'LAR-2'), activity: (await store.listActivity('larder', 'LAR-2')).map(({id, ...e}) => e),
    doc: await store.doc('larder', 'readme'), signals: await store.listSignals('larder'),
    secret: await secretsOf(store).get('STRIPE_KEY'),
    uploads: await Promise.all((await store.db.all<{id: string}>('SELECT id FROM uploads')).map(({id}) => store.upload(id))),
})

describe('copying an Orrery', () => {
    it('takes every table across with its ids, and goes on numbering after them', async () => {
        const source = await filled()
        const target = new Store(testDb())
        const copied = await copy(source.db, target.db)
        expect(copied).toMatchObject({projects: 1, issues: 2, comments: 2, statuses: 7, docs: 1, signals: 2, secrets: 1, secret_uses: 1, uploads: 1})
        expect(await everything(target)).toEqual(await everything(source))
        // New things get ids after the copied ones.
        expect((await target.createIssue('larder', {title: 'Next'})).id).toBe('LAR-3')
        expect((await target.createComment('larder', 'LAR-1', {body: 'later'})).id).toBeGreaterThan(2)
    })

    it('takes it back again unchanged', async () => {
        const source = await filled()
        const middle = new Store(testDb())
        await copy(source.db, middle.db)
        const back = new Store(new SqliteDb(openDb(':memory:')))
        await copy(middle.db, back.db)
        expect(await everything(back)).toEqual(await everything(source))
    })

    it("leaves out no table the migrations make, so a new one can't be forgotten", async () => {
        const db = openDb(':memory:')
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as {name: string}[]
        expect(tables.map(t => t.name).sort()).toEqual([...TABLES].sort())
    })

    it('refuses a target that already has projects', async () => {
        const source = await filled()
        await expect(copy(source.db, source.db)).rejects.toThrow('already has projects')
    })
})
