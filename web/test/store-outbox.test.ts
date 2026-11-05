// The outbox (ORR-929, step 3 of the `rust-api-events` decision): the store's own writes keep a row in `changes` for each
// thing they set off, as the Rust API's do, so the table holds every write whichever side made it. What the API made and
// this server is only told of has its rows already, so telling adds none. Against a fresh database (store-setup.ts).
import {beforeEach, describe, expect, it} from 'vitest'
import type {Actor, Store} from '../server/utils/store'
import {storeSetup} from './store-setup'

let store: Store

beforeEach(async () => {
    ({store} = await storeSetup())
})

const owner: Actor = {name: 'skoll', owner: true}
const session: Actor = {name: 'agent', owner: false, session: 'orrery · Vale'}

interface Row {id: number, kind: string, project: string | null, subject: string | null, actor: string | null, owner: number, session: string | null, untrusted: number, cause: string | null, payload: string | null}

/** The rows kept after `after`, once what was written after a commit has landed. */
async function kept(after = 0): Promise<Row[]> {
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    return await store.db.all<Row>('SELECT * FROM changes WHERE id > ? ORDER BY id', after)
}

const last = async () => (await kept()).at(-1)?.id ?? 0

describe('the outbox, for the store\'s own writes', () => {
    it('keeps a row for each thing a write set off, with who did it', async () => {
        const from = await last()
        const {id} = await store.createIssue('greenhouse', {title: 'Hinge the lid'}, session)
        const rows = await kept(from)
        expect(rows.map(r => [r.kind, r.project, r.subject])).toEqual(expect.arrayContaining([['project.changed', 'greenhouse', null], ['issue.created', 'greenhouse', id]]))
        expect(rows.find(r => r.kind === 'issue.created')).toMatchObject({actor: 'agent', owner: 0, session: 'orrery · Vale', untrusted: 0, cause: null})
    })

    it('keeps where a value went, and an untrusted session\'s and a schedule run\'s marks, for the guards', async () => {
        const {id} = await store.createIssue('greenhouse', {title: 'Oil it'}, owner)
        store.causeOf = () => 7
        const from = await last()
        await store.updateIssue('greenhouse', id, {status: 'done'}, {name: 'agent', owner: false, untrusted: true})
        const status = (await kept(from)).find(r => r.kind === 'issue.status')
        expect(status).toMatchObject({untrusted: 1, cause: '7'})
        expect(JSON.parse(status!.payload!)).toMatchObject({to: 'done'})
    })

    it('keeps nothing for a write that was refused', async () => {
        const from = await last()
        await expect(store.createIssue('greenhouse', {title: ' '}, session)).rejects.toMatchObject({statusCode: 400})
        expect(await kept(from)).toEqual([])
    })

    it('keeps a signal, an agent\'s comment for the bell, and a change to the settings', async () => {
        const {id} = await store.createIssue('greenhouse', {title: 'Paint it'}, owner)
        const from = await last()
        const signal = await store.focus('greenhouse', id, {}, owner)
        const comment = await store.createComment('greenhouse', id, {body: 'Which colour?'}, session)
        await store.updateSettings({tint: 'teal'}, owner)
        const rows = (await kept(from)).map(r => [r.kind, r.subject])
        expect(rows).toEqual(expect.arrayContaining([['signal', String(signal.id)], ['notice', String(comment.id)], ['settings', null]]))
    })
})

describe('the outbox, for what the Rust API made', () => {
    it('keeps nothing when told of it, as the API kept it already', async () => {
        const from = await last()
        store.told('doc.created', 'greenhouse', 'how-it-works', session)
        store.changed('greenhouse', false)
        await store.settingsChanged()
        expect(await kept(from)).toEqual([])
    })
})
