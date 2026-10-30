// The people on an orrery (ORR-653): the owner's row, adding, renaming and removing a member, and whose a session is.
// The store, against a fresh database with the project `greenhouse` (store-setup.ts).
import {beforeEach, describe, expect, it} from 'vitest'
import type {Actor, Store} from '../server/utils/store'
import {failure, storeSetup} from './store-setup'

let store: Store
const me: Actor = {name: 'skoll', owner: true}

beforeEach(async () => {
    ({store} = await storeSetup())
})

describe('the owner', () => {
    it('is a person once named, and stays one through a rename', async () => {
        await store.nameOwner({name: 'Skoll'})
        expect(await store.people()).toMatchObject([{id: 'skoll', name: 'Skoll', role: 'owner'}])
        await store.nameOwner({name: 'Sköll Fenrisson'}, me)
        expect(await store.people()).toMatchObject([{id: 'skoll_fenrisson', name: 'Sköll Fenrisson', role: 'owner'}])
        expect(await store.ownerOf()).toEqual({name: 'skoll_fenrisson', display: 'Sköll Fenrisson', named: true})
    })

    it("can't take a member's id, or be removed or renamed as a member", async () => {
        await store.nameOwner({name: 'Skoll'})
        await store.addPerson({name: 'Hati'})
        expect((await failure(() => store.nameOwner({name: 'Hati'}, me))).status).toBe(409)
        expect((await failure(() => store.removePerson('skoll', me))).status).toBe(400)
        expect((await failure(() => store.renamePerson('skoll', {name: 'Other'}))).status).toBe(400)
    })

    it('renaming moves what the rename used to leave behind', async () => {
        await store.nameOwner({name: 'Skoll'})
        await store.updateProject('greenhouse', {release_mode: 'own'}, me)
        await store.createRelease('greenhouse', {version: '1.0.0'}, me)
        await store.nameOwner({name: 'Hati'}, me)
        expect((await store.db.get<{created_by: string}>("SELECT created_by FROM releases WHERE version = '1.0.0'"))!.created_by).toBe('hati')
    })
})

describe('adding a person', () => {
    beforeEach(() => store.nameOwner({name: 'Skoll'}))

    it('makes a member, with an id from their name', async () => {
        expect(await store.addPerson({name: 'Mána Hati'})).toMatchObject({id: 'mana_hati', name: 'Mána Hati', role: 'member'})
        expect((await store.people()).map(p => p.id)).toEqual(['skoll', 'mana_hati'])
    })

    it.each(['owner', 'Agent', 'claude', 'orrery'])('refuses the reserved name %s', async name => {
        expect((await failure(() => store.addPerson({name}))).status).toBe(400)
    })

    it('refuses a name already taken, or one a removed person had', async () => {
        await store.addPerson({name: 'Hati'})
        expect((await failure(() => store.addPerson({name: 'hati'}))).status).toBe(409)
        await store.removePerson('hati', me)
        expect((await failure(() => store.addPerson({name: 'Hati'}))).status).toBe(409)
    })

    it('waits for the owner to have a name', async () => {
        const fresh = (await storeSetup()).store
        expect((await failure(() => fresh.addPerson({name: 'Hati'}))).status).toBe(400)
    })
})

describe('renaming a member', () => {
    it('changes the name and leaves the id, so what they hold stays theirs', async () => {
        await store.nameOwner({name: 'Skoll'})
        await store.addPerson({name: 'Hati'})
        const {id} = await store.createIssue('greenhouse', {title: 'Seed trays', assignee: 'hati'}, me)
        expect(await store.renamePerson('hati', {name: 'Hati Hróðvitnisson'})).toMatchObject({id: 'hati', name: 'Hati Hróðvitnisson'})
        expect((await store.issue('greenhouse', id)).assignee).toBe('hati')
    })

    it("doesn't find someone who isn't there", async () => {
        expect((await failure(() => store.renamePerson('nobody', {name: 'X'}))).status).toBe(404)
    })
})

describe('removing a member', () => {
    beforeEach(async () => {
        await store.nameOwner({name: 'Skoll'})
        await store.addPerson({name: 'Hati'})
    })

    it('sends their open issues back to unassigned, with a line, and leaves closed ones and history', async () => {
        const open = (await store.createIssue('greenhouse', {title: 'Open', assignee: 'hati', status: 'todo'}, me)).id
        const closed = (await store.createIssue('greenhouse', {title: 'Closed', assignee: 'hati', status: 'done'}, me)).id
        const theirs = (await store.createIssue('greenhouse', {title: 'Theirs'}, {name: 'hati', owner: false})).id
        await store.removePerson('hati', me)

        expect((await store.issue('greenhouse', open)).assignee).toBeUndefined()
        expect((await store.issue('greenhouse', closed)).assignee).toBe('hati')
        expect((await store.issue('greenhouse', theirs)).created_by).toBe('hati')
        expect((await store.listActivity('greenhouse', open)).at(-1)).toMatchObject({field: 'assignee', before: 'hati', created_by: 'skoll'})
        expect((await store.people()).find(p => p.id === 'hati')?.removed_at).toBeTruthy()
    })

    it('is done once', async () => {
        await store.removePerson('hati', me)
        const {removed_at} = (await store.people()).find(p => p.id === 'hati')!
        await store.removePerson('hati', me)
        expect((await store.people()).find(p => p.id === 'hati')!.removed_at).toBe(removed_at)
    })
})

describe('whose a session is', () => {
    it("is the owner's with one person, whatever it says, so older channels keep working", async () => {
        expect(await store.personFor(undefined)).toBe('owner')
        await store.nameOwner({name: 'Skoll'})
        expect(await store.personFor(undefined)).toBe('skoll')
        expect(await store.personFor('hati')).toBe('skoll')
    })

    it('with more, is who it names, by id or name, and nobody otherwise', async () => {
        await store.nameOwner({name: 'Skoll'})
        await store.addPerson({name: 'Mána Hati'})
        expect(await store.personFor('mana_hati')).toBe('mana_hati')
        expect(await store.personFor('Mána Hati')).toBe('mana_hati')
        expect(await store.personFor('skoll')).toBe('skoll')
        expect(await store.personFor(undefined)).toBeUndefined()
        expect(await store.personFor('fenrir')).toBeUndefined()
    })

    it("goes back to the owner's once the only member is removed, and a removed one is nobody while others remain", async () => {
        await store.nameOwner({name: 'Skoll'})
        await store.addPerson({name: 'Hati'})
        await store.addPerson({name: 'Fenrir'})
        await store.removePerson('hati', me)
        expect(await store.personFor('hati')).toBeUndefined()
        await store.removePerson('fenrir', me)
        expect(await store.personFor('hati')).toBe('skoll')
    })
})
