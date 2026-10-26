import {describe, expect, it} from 'vitest'
import type {Signal} from '#shared/roadmap'
import {foldRepeats} from '../server/utils/signals'

const signal = (id: number, more: Partial<Signal>): Signal =>
    ({id, project: 'larder', kind: 'message', delivered_to: [], instructions: [], created_by: 'ada', protected: true, created_at: '', ...more})

describe('a backlog of signals', () => {
    it("keeps a schedule's newest copy of the same message, where it came", () => {
        const backlog = [
            signal(1, {schedule: 4, note: 'Idle? Check the issues.'}),
            signal(2, {kind: 'focus', issue: 'LAR-1'}),
            signal(3, {schedule: 4, note: 'Idle? Check the issues.'}),
            signal(4, {schedule: 4, note: 'Idle? Check the issues.'}),
        ]
        const {kept, repeats} = foldRepeats(backlog)
        expect(kept.map(s => s.id)).toEqual([2, 4])
        expect(repeats.map(s => s.id)).toEqual([1, 3])
    })

    it('keeps every message that differs: another schedule, text or session, and anything not a message', () => {
        const backlog = [
            signal(1, {schedule: 4, note: 'Check CI'}),
            signal(2, {schedule: 5, note: 'Check CI'}),
            signal(3, {schedule: 4, note: 'Check the PRs'}),
            signal(4, {schedule: 4, note: 'Check CI', target: 'abc'}),
            signal(5, {kind: 'focus', issue: 'LAR-1'}),
            signal(6, {kind: 'focus', issue: 'LAR-1'}),
        ]
        expect(foldRepeats(backlog)).toEqual({kept: backlog, repeats: []})
    })
})
