// The outbox's rows for what reaches sessions and the owner (ORR-929): each signal, each agent's comment for the bell,
// and where an event's value went, so the local app can act on them from the feed as it does from the hooks today.
import {beforeEach, describe, expect, it} from 'vitest'
import type {Actor, Store} from '../server/utils/store'
import {storeSetup} from './store-setup'

const OWNER: Actor = {name: 'owner', owner: true}
const SESSION: Actor = {name: 'claude', owner: false, session: 'orrery · Vale'}
const tick = () => new Promise(resolve => setTimeout(resolve, 5))

let store: Store
let from: number

/** The rows since the test began, once they've stopped coming: some are written just after their write returns, which
 * on a busy Postgres takes longer than a tick (ORR-976's flake, on the parity test). */
async function rows() {
    const read = () => store.db.all<{kind: string, project: string | null, subject: string | null, payload: string | null}>(
        'SELECT kind, project, subject, payload FROM changes WHERE id > ? ORDER BY id', from)
    let seen = JSON.stringify(await read())
    for (;;) {
        await new Promise(resolve => setTimeout(resolve, 40))
        const now = await read()
        if (JSON.stringify(now) === seen) return now
        seen = JSON.stringify(now)
    }
}

beforeEach(async () => {
    ;({store} = await storeSetup())
    await tick()
    from = Number((await store.db.get<{n: number | null}>('SELECT max(id) AS n FROM changes'))?.n ?? 0)
})

describe('the outbox, for sessions and the bell', () => {
    it('keeps a signal by its id', async () => {
        const {id} = await store.createIssue('greenhouse', {title: 'Paint it'}, OWNER)
        const signal = await store.focus('greenhouse', id, {}, OWNER)
        expect(await rows()).toContainEqual({kind: 'signal', project: 'greenhouse', subject: String(signal.id), payload: null})
    })

    it("keeps an agent's comment for the bell, with its issue, and not the owner's own", async () => {
        const {id} = await store.createIssue('greenhouse', {title: 'Paint it'}, OWNER)
        const comment = await store.createComment('greenhouse', id, {body: 'Which colour?'}, SESSION)
        await store.createComment('greenhouse', id, {body: 'Teal.'}, OWNER)
        const notices = (await rows()).filter(r => r.kind === 'notice')
        expect(notices).toEqual([{kind: 'notice', project: 'greenhouse', subject: String(comment.id), payload: JSON.stringify({issue: id})}])
    })

    it('keeps where a value went, for what a schedule matches on', async () => {
        const {id} = await store.createIssue('greenhouse', {title: 'Oil it'}, OWNER)
        await store.updateIssue('greenhouse', id, {status: 'done'}, SESSION)
        const status = (await rows()).find(r => r.kind === 'issue.status')
        expect(JSON.parse(status!.payload!)).toMatchObject({to: 'done'})
    })

    it('keeps nothing extra for an event with no value', async () => {
        const {id} = await store.createIssue('greenhouse', {title: 'Sand it'}, SESSION)
        expect((await rows()).find(r => r.kind === 'issue.created' && r.subject === id)?.payload).toBeNull()
    })
})
