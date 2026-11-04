import {describe, expect, it} from 'vitest'
import {anchored, inView} from '../app/composables/useSessionsFloat'

// Where the floating sessions panel is kept (ORR-901): by the corner of the window it's nearest to, so a smaller
// window keeps it in sight.
const view = {width: 1280, height: 800}

describe('the floating sessions panel', () => {
    it('keeps it by the nearest corner, with how far from it', () => {
        expect(anchored(1000, 64, 256, 200, view)).toEqual({corner: 'top-right', x: 24, y: 64})
        expect(anchored(40, 500, 256, 200, view)).toEqual({corner: 'bottom-left', x: 40, y: 100})
        expect(anchored(30, 30, 256, 200, view)).toEqual({corner: 'top-left', x: 30, y: 30})
        expect(anchored(1000, 590, 256, 200, view)).toEqual({corner: 'bottom-right', x: 24, y: 10})
    })

    it('never lets it past the edge, and keeps it in a window made smaller', () => {
        expect(anchored(-50, -20, 256, 200, view)).toEqual({corner: 'top-left', x: 8, y: 8})
        expect(inView({corner: 'top-left', x: 1200, y: 700}, 256, 200, view)).toEqual({corner: 'top-left', x: 1016, y: 592})
        expect(inView({corner: 'top-right', x: 16, y: 64}, 256, 200, {width: 200, height: 150})).toEqual({corner: 'top-right', x: 8, y: 8})
    })
})
