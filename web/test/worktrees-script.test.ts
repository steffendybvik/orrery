import {describe, expect, it} from 'vitest'
// @ts-expect-error: a plain script, run by node
import {IN_USE_FOR, parseWorktrees, whyKept} from '../scripts/worktrees.mjs'

const now = 1_000_000_000_000
const safe = {path: '/apps/orrery-worktrees/orr-1', locked: false, dirty: false, inUse: false, touched: now - IN_USE_FOR - 1, onGitHub: true}

describe('tidying the worktrees sessions left behind', () => {
    it('removes one that is clean, idle, old and on GitHub', () => {
        expect(whyKept(safe, now)).toBeNull()
    })

    it('removes one whose head is a merged PR, however recently it was touched', () => {
        expect(whyKept({...safe, merged: true, touched: now - 1000, onGitHub: false}, now)).toBeNull()
    })

    it('keeps a merged one that is locked, dirty or in use, as a commit on top would show as another head', () => {
        expect(whyKept({...safe, merged: true, locked: true}, now)).toBe('locked')
        expect(whyKept({...safe, merged: true, dirty: true}, now)).toBe('uncommitted changes')
        expect(whyKept({...safe, merged: true, inUse: true}, now)).toBe('a process is running from it')
    })

    it('keeps anything that could still hold work, or be in use', () => {
        expect(whyKept({...safe, path: '/apps/orrery-playground'}, now)).toBe('the playground')
        expect(whyKept({...safe, locked: true}, now)).toBe('locked')
        expect(whyKept({...safe, dirty: true}, now)).toBe('uncommitted changes')
        expect(whyKept({...safe, inUse: true}, now)).toBe('a process is running from it')
        expect(whyKept({...safe, touched: now - 1000}, now)).toBe('touched in the last 24h')
        expect(whyKept({...safe, onGitHub: false}, now)).toBe('commits not on GitHub')
    })

    it('reads git\'s list, with the main checkout first', () => {
        const listed = 'worktree /apps/orrery\nHEAD abc\nbranch refs/heads/main\n\nworktree /apps/orrery-1\nHEAD def\ndetached\nlocked why\n\n'
        expect(parseWorktrees(listed)).toEqual([{path: '/apps/orrery', locked: false}, {path: '/apps/orrery-1', locked: true}])
    })
})
