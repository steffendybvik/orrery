import {describe, expect, it} from 'vitest'
import {afterLogin} from '../app/utils/afterLogin'

// The page a browser sent to log in was going to (ORR-1192), once it's in.
describe('afterLogin', () => {
    it('goes back to the kept page, and clears it', () => {
        expect(afterLogin('/connect-machine?request=abc', '/mine')).toEqual({clear: true, go: '/connect-machine?request=abc'})
    })

    // `/` redirects to `/mine` before the page starts, so a logged-out visit to `/` keeps `/mine`, and the login lands
    // there already: left behind, the key sent the next load in the tab, a board's, to My issues (ORR-1227).
    it('clears the kept page when already on it, without going anywhere', () => {
        expect(afterLogin('/mine', '/mine')).toEqual({clear: true})
    })

    it('does nothing with none kept', () => {
        expect(afterLogin(null, '/p/greenhouse')).toEqual({clear: false})
    })
})
