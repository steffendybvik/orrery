import {beforeEach, describe, expect, it} from 'vitest'
import type {Project} from '#shared/roadmap'
import {applyPatch, diffProject} from '#shared/patch'
import {Store} from '../server/utils/store'
import {testDb} from './db'

// A change sent to the page as what changed, not the whole project (ORR-440): the page builds the project again from
// the patch and what it had, and gets just what a fresh read would give.
let store: Store

beforeEach(async () => {
    store = new Store(testDb())
    await store.createProject({name: 'greenhouse', key: 'GRE', release_mode: 'own'})
    await store.createChunk('greenhouse', {title: 'Frames'})
    await store.createChunk('greenhouse', {title: 'Glass'})
    const parent = await store.createIssue('greenhouse', {title: 'Doors', chunk: '1'})
    await store.createIssue('greenhouse', {title: 'Hinges', parent: parent.id})
    await store.createIssue('greenhouse', {title: 'Panes', chunk: '2'})
    await store.createIssue('greenhouse', {title: 'Loose one'})
})

/** As the page gets it: through JSON, which drops what's undefined. */
const sent = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** The patch from `before` to the project as it is now, sent and applied to `before` as the page had it, against a
 * fresh read as it would have come. */
async function roundTrip(before: Project) {
    const after = await store.project('greenhouse')
    const patch = diffProject(before, after, 1, 2)
    expect(sent(applyPatch(sent(before), sent(patch)))).toEqual(sent(after))
    return patch
}

describe('patches', () => {
    it('send a changed issue alone, and its chunk as ids, leaving the other chunks out', async () => {
        const before = await store.project('greenhouse')
        await store.updateIssue('greenhouse', 'GRE-2', {title: 'Brass hinges'})
        const patch = await roundTrip(before)
        expect(Object.keys(patch.issues)).toEqual(['GRE-2'])
        expect(patch.board.chunks.filter(c => 'same' in c).map(c => c.id)).toEqual(['2', ''].filter(id => before.board.chunks.some(c => c.id === id)))
    })

    it('move, nest, add and remove issues, and change chunks and the project', async () => {
        const before = await store.project('greenhouse')
        await store.updateIssue('greenhouse', 'GRE-3', {parent: 'GRE-1'})
        await store.createIssue('greenhouse', {title: 'Vents', chunk: '2'})
        await store.deleteIssue('greenhouse', 'GRE-4')
        await store.updateChunk('greenhouse', '1', {title: 'Timber frames'})
        await store.updateProject('greenhouse', {description: 'A glasshouse', icon: 'home'})
        const patch = await roundTrip(before)
        expect(patch.fields).toMatchObject({description: 'A glasshouse', icon: 'home'})
        const between = await store.project('greenhouse')
        await store.updateProject('greenhouse', {icon: null})
        expect((await roundTrip(between)).unset).toEqual(['icon'])
    })

    it('send nothing of an issue or chunk that did not change', async () => {
        const before = await store.project('greenhouse')
        const patch = await roundTrip(before)
        expect(patch.issues).toEqual({})
        expect(patch.board.chunks.every(c => 'same' in c)).toBe(true)
    })

    it('make a whole project from nothing, and say when one cannot be applied', async () => {
        const after = await store.project('greenhouse')
        const whole = diffProject(undefined, after, 0, 1)
        expect(sent(applyPatch({board: {chunks: []}} as unknown as Project, sent(whole)))).toEqual(sent(after))
        const before = await store.project('greenhouse')
        await store.updateIssue('greenhouse', 'GRE-1', {title: 'Double doors'})
        const patch = diffProject(before, await store.project('greenhouse'), 1, 2)
        expect(applyPatch({...before, board: {...before.board, chunks: []}}, patch)).toBeNull()
    })
})
