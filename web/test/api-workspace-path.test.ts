import {describe, expect, it} from 'vitest'
import {pagePath, workspaceIn} from '../app/utils/api'

// A page under `/w/<workspace>/…` is the same page (ORR-1108): its own path is what a highlight compares.
describe('pagePath', () => {
    it('drops the workspace a page is under', () => {
        expect(pagePath('/w/acme/mine')).toBe('/mine')
        expect(pagePath('/w/acme')).toBe('/')
        expect(pagePath('/w/acme/p/rockets/issues')).toBe('/p/rockets/issues')
    })

    it('leaves a page under none as it is', () => {
        expect(pagePath('/mine')).toBe('/mine')
        expect(pagePath('/')).toBe('/')
        expect(pagePath('/workspaces')).toBe('/workspaces')
    })

    it('agrees with workspaceIn on which workspace', () => {
        expect(workspaceIn('/w/acme/mine')).toBe('acme')
        expect(workspaceIn('/mine')).toBeUndefined()
    })
})
