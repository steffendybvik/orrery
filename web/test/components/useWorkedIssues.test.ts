import {describe, expect, it} from 'vitest'
import {registerEndpoint} from '@nuxt/test-utils/runtime'
import type {Session} from '#shared/roadmap'

// Which issues each listening session is on (useWorkedIssues), read once for every project: who works an issue, for
// its row, and what a session is on, for the sidebar's second line (ORR-484), newest first across the projects it hears.
const session = (id: string, project: string, also: string[] = []) =>
    ({id, name: `orrery · ${id}`, project, also, state: 'working', listening: true}) as unknown as Session
const issue = (id: string, since: string) => ({id, title: `Title of ${id}`, column: 'in-progress', kind: 'started', since})

registerEndpoint('/api/sessions/work', () => ({
    greenhouse: {
        shelves: {issues: [issue('GRE-3', '2026-10-30T07:00:00Z'), issue('GRE-1', '2026-10-30T06:00:00Z')], signals: []},
        hinges: {issues: [], signals: []},
    },
    pantry: {shelves: {issues: [issue('PAN-2', '2026-10-30T06:30:00Z')], signals: []}},
}))

describe('useWorkedIssues', () => {
    it("gives a session's issues newest first, across the projects it hears, and who works each issue", async () => {
        useState<Record<string, Session[]>>('projects-sessions').value = {
            greenhouse: [session('shelves', 'greenhouse', ['pantry']), session('hinges', 'greenhouse')],
            pantry: [session('shelves', 'greenhouse', ['pantry'])],
        }
        const {issuesOf, workerOf} = useWorkedIssues()
        await expect.poll(() => issuesOf('shelves').map(i => `${i.project}/${i.id}`)).toEqual(['greenhouse/GRE-3', 'pantry/PAN-2', 'greenhouse/GRE-1'])
        expect(issuesOf('hinges')).toEqual([])
        expect(issuesOf('nobody')).toEqual([])
        expect(workerOf('pantry', 'PAN-2')?.id).toBe('shelves')
    })
})
