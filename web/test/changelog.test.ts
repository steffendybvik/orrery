import {describe, expect, it} from 'vitest'
import type {Chunk, Issue, Release} from '#shared/roadmap'
import {changelogGroup, changelogOf} from '../app/utils/roadmap'

// The release page's changelog draft, grouped under Features, Changes, Fixes, Docs and Internal (ORR-516).
const release = {version: '1.0.0-rc.11'} as Release
const issue = (id: string, title: string, more: Partial<Issue> = {}) => ({id, title, kind: 'done', labels: [], ...more}) as unknown as Issue
const chunks = (...tasks: Issue[]) => [{tasks}] as unknown as Chunk[]

describe('the changelog draft', () => {
    it('puts each issue in the first group its labels name, else Changes', () => {
        expect(changelogGroup({labels: ['Feature request']})).toBe('Features')
        expect(changelogGroup({labels: ['bug', 'docs']})).toBe('Fixes')
        expect(changelogGroup({labels: ['documentation']})).toBe('Docs')
        expect(changelogGroup({labels: ['test']})).toBe('Internal')
        expect(changelogGroup({labels: ['improvement']})).toBe('Changes')
        expect(changelogGroup({labels: ['ui']})).toBe('Changes')
    })

    it('lists the groups in order, leaving out empty ones, each most urgent first then by id, and the open ones last', () => {
        expect(changelogOf(release, chunks(
            issue('ORR-12', 'Crash on save', {labels: ['bug']}),
            issue('ORR-9', 'Chat button', {labels: ['ui']}),
            issue('ORR-10', 'Pull requests page', {labels: ['feature request'], priority: 'P1'}),
            issue('ORR-3', 'Typo in a toast', {labels: ['bug'], priority: 'P0'}),
            issue('ORR-11', 'Start several sessions', {labels: ['feature request']}),
            issue('ORR-8', 'Unit-test the stream', {labels: ['test']}),
            issue('ORR-20', 'Still going', {kind: 'started'}),
        ), '2026-10-29')).toBe([
            '## 1.0.0-rc.11 (2026-10-29)',
            '', '### Features', '', '- Pull requests page (ORR-10)', '- Start several sessions (ORR-11)',
            '', '### Changes', '', '- Chat button (ORR-9)',
            '', '### Fixes', '', '- Typo in a toast (ORR-3)', '- Crash on save (ORR-12)',
            '', '### Internal', '', '- Unit-test the stream (ORR-8)',
            '', '<!-- Not done yet -->', '- Still going (ORR-20)',
        ].join('\n'))
    })

    it('says nothing is done yet when nothing is', () => {
        expect(changelogOf(release, chunks(issue('ORR-1', 'Soon', {kind: 'todo'})))).toBe('## 1.0.0-rc.11 (unreleased)\n\n- Nothing done yet\n\n<!-- Not done yet -->\n- Soon (ORR-1)')
    })
})
