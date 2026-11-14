import {describe, expect, it} from 'vitest'
import {workspaceHeader} from '../server/utils/api-router'

// The workspace a page or session names goes on to the API as it came (ORR-1107), which checks it's the asker's.
describe('workspaceHeader', () => {
    it('passes a workspace on, trimmed', () => {
        expect(workspaceHeader(' acme ')).toEqual({'Orrery-Workspace': 'acme'})
    })

    it('sends none for none, an empty one, or one no header could carry', () => {
        expect(workspaceHeader(undefined)).toEqual({})
        expect(workspaceHeader('  ')).toEqual({})
        expect(workspaceHeader('two words')).toEqual({})
        expect(workspaceHeader('x'.repeat(65))).toEqual({})
    })
})
