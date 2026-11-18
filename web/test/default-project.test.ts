import {describe, expect, it} from 'vitest'
import type {Project} from '#shared/roadmap'
import {defaultProject} from '../app/utils/default-project'

const project = (id: string, open = 0) => ({id, name: id, board: {milestones: [], counts: {}, kinds: {backlog: 0, todo: open, started: 0, done: 3}}}) as unknown as Project
const none = () => false

// ORR-1284: a page of no project opens on the one last used, else a starred one, else the busiest, never an empty one.
describe('defaultProject', () => {
    const list = [project('empty'), project('shop', 2), project('blog', 5)]

    it('takes the one with the most open issues, not the first by name', () => {
        expect(defaultProject(list, null, none, none)?.id).toBe('blog')
    })

    it('keeps the sidebar order on a tie', () => {
        expect(defaultProject([project('a', 1), project('b', 1)], null, none, none)?.id).toBe('a')
    })

    it('prefers a starred one to the busiest', () => {
        expect(defaultProject(list, null, id => id === 'shop', none)?.id).toBe('shop')
    })

    it('prefers the last used to a starred one', () => {
        expect(defaultProject(list, 'empty', id => id === 'shop', none)?.id).toBe('empty')
    })

    it('ignores a last used project that is gone', () => {
        expect(defaultProject(list, 'gone', none, none)?.id).toBe('blog')
    })

    it('leaves hidden ones out unless nothing else is left', () => {
        expect(defaultProject(list, null, none, id => id === 'blog')?.id).toBe('shop')
        expect(defaultProject([project('only')], null, none, () => true)?.id).toBe('only')
    })

    it('has nothing to pick with no projects', () => {
        expect(defaultProject([], null, none, none)).toBeUndefined()
    })
})
