// The path as the routers read it (`pathOf`): lowercased to match a route, or as asked for what reads an id out of it.
import {describe, expect, it} from 'vitest'
import {pathOf} from '../server/utils/auth'

describe('pathOf', () => {
    it('reads every spelling of a path as one, lowercased', () => {
        expect(pathOf({path: '/API//Projects\\Cellar/issues/CEL-1?x=1'})).toBe('/api/projects/cellar/issues/cel-1')
        expect(pathOf({path: '/api/%2E%2E/%ZZ'})).toBe('/api/')
    })

    it("keeps an id's case when asked, as an issue is CEL-1 to the store (ORR-1029)", () => {
        expect(pathOf({path: '/api//projects/cellar/issues/CEL-1/?x=1'}, true)).toBe('/api/projects/cellar/issues/CEL-1/')
        expect(pathOf({path: '/api/projects/cellar/issues/CEL%2D1'}, true)).toBe('/api/projects/cellar/issues/CEL-1')
    })
})
