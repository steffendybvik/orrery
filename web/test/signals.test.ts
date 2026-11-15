import {describe, expect, it} from 'vitest'
import type {Signal} from '#shared/roadmap'
import {foldRepeats} from '../server/utils/signals'

const signal = (id: number, more: Partial<Signal>): Signal =>
    ({id, project: 'greenhouse', kind: 'message', delivered_to: [], instructions: [], created_by: 'ada', protected: true, created_at: '', ...more})

describe('a backlog of signals', () => {
    it("keeps a schedule's newest copy of the same message, where it came", () => {
        const backlog = [
            signal(1, {schedule: 4, note: 'Idle? Check the issues.'}),
            signal(2, {kind: 'focus', issue: 'GRE-1'}),
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
            signal(5, {kind: 'focus', issue: 'GRE-1'}),
            signal(6, {kind: 'focus', issue: 'GRE-2'}),
            signal(7, {kind: 'focus', issue: 'GRE-1', target: 'abc'}),
        ]
        expect(foldRepeats(backlog)).toEqual({kept: backlog, repeats: []})
    })

    it('keeps the newest focus on one issue for the same sessions (ORR-1178)', () => {
        const backlog = [signal(1, {kind: 'focus', issue: 'GRE-1'}), signal(2, {kind: 'comment', issue: 'GRE-1', note: 'hi'}), signal(3, {kind: 'focus', issue: 'GRE-1'})]
        expect(foldRepeats(backlog)).toEqual({kept: backlog.slice(1), repeats: backlog.slice(0, 1)})
    })

    it("keeps orrery's newest news of a pull request on an issue, as an older one is stale (ORR-1178)", () => {
        const pr = (n: number, repo = 'acme/greenhouse') => `[#${n}](https://github.com/${repo}/pull/${n})`
        const news = (id: number, note: string, more: Partial<Signal> = {}) => signal(id, {kind: 'comment', issue: 'GRE-1', created_by: 'orrery', note, ...more})
        const backlog = [
            news(1, `${pr(7)} conflicts with \`main\`: merge it.`),
            news(2, `${pr(7)}'s checks fail.`),
            news(3, `${pr(8)} conflicts with \`main\`.`),
            news(4, `${pr(7, 'acme/shed')} conflicts with \`main\`.`),
            news(5, `${pr(7)} conflicts with \`main\`.`, {issue: 'GRE-2'}),
            news(6, `${pr(7)} conflicts with \`main\`.`, {created_by: 'ada'}),
            news(7, `${pr(7)} was merged into \`main\`.`),
        ]
        const {kept, repeats} = foldRepeats(backlog)
        expect(repeats.map(s => s.id)).toEqual([1, 2])
        expect(kept.map(s => s.id)).toEqual([3, 4, 5, 6, 7])
    })
})
