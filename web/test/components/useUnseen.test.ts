import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {DocSummary, Issue, Project, Schedule} from '#shared/roadmap'

// What changed since the owner last looked (useUnseen): an issue or doc past when it was seen, remembered in this
// browser, the owner's own new things and closed issues never news, and a write from the page not news when it comes
// back (ORR-586).
const SINCE = '2026-10-29T10:00:00.000Z'
const later = (minutes: number) => new Date(Date.parse(SINCE) + minutes * 60_000).toISOString()

const issue = (id: string, at: string, more: Partial<Issue> = {}) =>
    ({id, kind: 'todo', created_by: 'claude', created_at: SINCE, updated_at: at, tasks: [], ...more}) as unknown as Issue
const doc = (id: string, at: string) => ({id, created_by: 'claude', created_at: SINCE, updated_at: at}) as unknown as DocSummary
const project = (issues: Issue[], docs: DocSummary[] = []) =>
    ({id: 'greenhouse', docs, board: {chunks: [{id: '1', tasks: issues}]}}) as unknown as Project

beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('orrery-seen', JSON.stringify({since: SINCE, items: {}}))
    clearNuxtState(['seen', 'seen-wrote'])
    useState('owner').value = {name: 'skoll', display: 'Skoll', named: true}
})
afterEach(() => vi.useRealTimers())

describe('useUnseen', () => {
    it('marks what changed since the first visit until it is seen, and remembers it in the browser', () => {
        const {issueUnseen, seeIssue, docUnseen, seeDoc} = useUnseen()
        const old = issue('GRE-1', SINCE)
        const fresh = issue('GRE-2', later(5))
        expect(issueUnseen('greenhouse', old)).toBe(false)
        expect(issueUnseen('greenhouse', fresh)).toBe(true)
        seeIssue('greenhouse', fresh)
        expect(issueUnseen('greenhouse', fresh)).toBe(false)
        // Changed again since.
        expect(issueUnseen('greenhouse', {...fresh, updated_at: later(6)})).toBe(true)
        expect(JSON.parse(localStorage.getItem('orrery-seen')!).items).toEqual({'greenhouse/GRE-2': later(5)})

        const notes = doc('notes', later(3))
        expect(docUnseen('greenhouse', notes)).toBe(true)
        seeDoc('greenhouse', notes)
        expect(docUnseen('greenhouse', notes)).toBe(false)
    })

    it("never counts a closed issue, the owner's own new one, or one of the owner's schedules", () => {
        const {issueUnseen, scheduleUnseen} = useUnseen()
        expect(issueUnseen('greenhouse', issue('GRE-1', later(5), {kind: 'done'}))).toBe(false)
        expect(issueUnseen('greenhouse', issue('GRE-2', later(5), {created_by: 'skoll', created_at: later(5)}))).toBe(false)
        // Made by the owner but changed by someone since is news.
        expect(issueUnseen('greenhouse', issue('GRE-3', later(6), {created_by: 'skoll', created_at: later(5)}))).toBe(true)
        const schedule = {id: 3, project: 'greenhouse', created_by: 'claude', created_at: SINCE, updated_at: later(5)} as unknown as Schedule
        expect(scheduleUnseen({...schedule, protected: true})).toBe(false)
        expect(scheduleUnseen({...schedule, protected: false})).toBe(true)
    })

    it("counts and clears a project's news", () => {
        const {unseenIn, seeAll} = useUnseen()
        const sub = issue('GRE-2', later(2))
        const p = project([issue('GRE-1', later(1), {tasks: [sub]}), issue('GRE-3', SINCE)], [doc('notes', later(3))])
        expect(unseenIn(p)).toBe(3)
        seeAll(p)
        expect(unseenIn(p)).toBe(0)
    })

    it("takes a write from this page as seen when it comes back, but only that first change", () => {
        vi.useFakeTimers({now: Date.parse(later(10))})
        const {issueUnseen, wroteTo, ownChanges} = useUnseen()
        wroteTo('/api/projects/greenhouse/issues/GRE-1/comments')
        ownChanges(project([issue('GRE-1', later(10))]))
        expect(issueUnseen('greenhouse', issue('GRE-1', later(10)))).toBe(false)
        // An agent's change right after is news again.
        ownChanges(project([issue('GRE-1', later(11))]))
        expect(issueUnseen('greenhouse', issue('GRE-1', later(11)))).toBe(true)
        // A write long past is no cover.
        wroteTo('/api/projects/greenhouse/issues/GRE-4')
        vi.advanceTimersByTime(11_000)
        ownChanges(project([issue('GRE-4', later(12))]))
        expect(issueUnseen('greenhouse', issue('GRE-4', later(12)))).toBe(true)
    })

    it("keeps a doc's text as read, drops one too long to keep, and the oldest past the total", () => {
        const {read, lastRead} = useUnseen()
        read('greenhouse', 'notes', 'Water daily.')
        expect(lastRead('greenhouse', 'notes')).toBe('Water daily.')
        read('greenhouse', 'notes', 'x'.repeat(200_001))
        expect(lastRead('greenhouse', 'notes')).toBeUndefined()
        read('greenhouse', 'a', 'a'.repeat(200_000))
        for (const id of ['b', 'c', 'd', 'e', 'f']) read('greenhouse', id, id.repeat(200_000))
        expect(lastRead('greenhouse', 'a')).toBeUndefined()
        expect(lastRead('greenhouse', 'f')).toHaveLength(200_000)
    })
})
