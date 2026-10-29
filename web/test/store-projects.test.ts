// Projects: made, named, iconed, pointed at their repo, and deleted with all that's in them. The store, against a fresh
// database with the project `greenhouse` (store-setup.ts).
import {beforeEach, describe, expect, it} from 'vitest'
import type {Store} from '../server/utils/store'
import {failure, storeSetup} from './store-setup'

let store: Store

beforeEach(async () => {
    ({store} = await storeSetup())
})

describe('projects', () => {
    it('makes an id and key from the name', async () => {
        const project = await store.createProject({name: 'Fitness App'})
        expect([project.id, project.key]).toEqual(['fitness-app', 'FIT'])
        expect((await failure(() => store.createProject({name: 'fitness app'}))).status).toBe(409)
    })

    it('refuses unknown fields', async () => {
        expect(await failure(() => store.createProject({name: 'x', colour: 'red'})))
            .toEqual({status: 400, message: 'unknown field "colour"; this takes id, name, key, description, icon, icon_color, focus_prompt, chunk_prompt, instructions, muted, repo, release_mode, releases_from'})
    })

    it('keep where their code is', async () => {
        expect((await store.updateProject('greenhouse', {repo: 'https://github.com/you/greenhouse'})).repo).toBe('https://github.com/you/greenhouse')
        expect((await failure(() => store.updateProject('greenhouse', {repo: 'github.com/you/greenhouse'}))).status).toBe(400)
        expect((await store.updateProject('greenhouse', {repo: null})).repo).toBeUndefined()
        expect((await store.createProject({name: 'pantry', repo: 'https://git.example/pantry'})).repo).toBe('https://git.example/pantry')
    })

    it('keep an icon to set and clear', async () => {
        expect((await store.updateProject('greenhouse', {icon: 'shopping-cart'})).icon).toBe('shopping-cart')
        expect((await failure(() => store.updateProject('greenhouse', {icon: 'Cart Icon'}))).status).toBe(400)
        expect((await store.updateProject('greenhouse', {icon: null})).icon).toBeUndefined()
    })

    it("keep an icon colour, a tint's name or a #rrggbb", async () => {
        expect((await store.updateProject('greenhouse', {icon_color: 'teal'})).icon_color).toBe('teal')
        expect((await store.updateProject('greenhouse', {icon_color: '#123abc'})).icon_color).toBe('#123abc')
        expect((await failure(() => store.updateProject('greenhouse', {icon_color: 'red; background: url(x)'}))).status).toBe(400)
        expect((await store.updateProject('greenhouse', {icon_color: null})).icon_color).toBeUndefined()
    })

    it('deletes everything in it', async () => {
        const issue = await store.createIssue('greenhouse', {title: 'A'})
        await store.createComment('greenhouse', issue.id, {body: 'hi'})
        await store.deleteProject('greenhouse')
        expect(await store.listProjects()).toEqual([])
        expect(await store.db.get('SELECT count(*) AS n FROM comments')).toEqual({n: 0})
    })
})
