import {describe, expect, it} from 'vitest'
import type {Issue} from '#shared/roadmap'
import {boardCards, filterTree} from '../app/utils/roadmap'

// The board's cards (ORR-1061): a status the filter leaves out gets no column, so a parent kept only for a sub-issue
// that matches gives way to that sub-issue.
const issue = (id: string, column: string, tasks: Issue[] = []) => ({id, column, tasks}) as unknown as Issue
const open = ['todo', 'in-progress']
const matching = (issues: Issue[]) => filterTree(issues, i => open.includes(i.column))

describe('the board cards', () => {
    it('keeps a parent whose status the filter takes, with its sub-issues', () => {
        const cards = boardCards(matching([issue('P', 'todo', [issue('P1', 'done'), issue('P2', 'in-progress')])]), open)
        expect(cards.map(i => i.id)).toEqual(['P'])
        expect(cards[0]!.tasks.map(i => i.id)).toEqual(['P2'])
    })

    it("lifts a closed or proposed parent's matching sub-issues into their own columns", () => {
        const cards = boardCards(matching([
            issue('A', 'todo'),
            issue('D', 'done', [issue('D1', 'todo'), issue('D2', 'canceled')]),
            issue('X', 'proposed', [issue('X1', 'backlog', [issue('X11', 'in-progress')])]),
        ]), open)
        expect(cards.map(i => [i.id, i.column])).toEqual([['A', 'todo'], ['D1', 'todo'], ['X11', 'in-progress']])
    })

    it('leaves every issue as it is with no status picked', () => {
        const issues = [issue('D', 'done', [issue('D1', 'todo')]), issue('C', 'canceled')]
        expect(boardCards(issues, [])).toEqual(issues)
    })
})
