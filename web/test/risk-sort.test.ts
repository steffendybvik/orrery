import {describe, expect, it} from 'vitest'
import type {Issue, RiskLevel} from '#shared/roadmap'
import {byRisk, riskRank} from '../app/utils/roadmap'

// Riskiest first (ORR-879): the release page's issues, and the list when sorted by Risk.
const issue = (id: string, level?: RiskLevel, tasks: Issue[] = []) =>
    ({id, tasks, ...level ? {risk: {level, why: 'x', by: 'session'}} : {}}) as unknown as Issue

describe('sorting issues by risk', () => {
    it('puts the riskiest first, unrated after low, and keeps the order among equals', () => {
        const sorted = byRisk([issue('A'), issue('B', 'low'), issue('C', 'high'), issue('D'), issue('E', 'medium'), issue('F', 'high')])
        expect(sorted.map(i => i.id)).toEqual(['C', 'F', 'E', 'B', 'A', 'D'])
    })

    it('ranks a parent by its riskiest sub-issue, and sorts the sub-issues too', () => {
        const parent = issue('P', 'low', [issue('P1', 'low'), issue('P2', 'high')])
        expect(riskRank(parent)).toBe(0)
        const [first, second] = byRisk([issue('A', 'medium'), parent])
        expect(first!.id).toBe('P')
        expect(first!.tasks.map(i => i.id)).toEqual(['P2', 'P1'])
        expect(second!.id).toBe('A')
    })
})
