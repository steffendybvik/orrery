import {test} from './test'
import type {Walked} from './pages'
import {walkProject} from './pages'
import {wcagWalk} from './walks'

// Every page in dark mode breaks no WCAG A or AA rule beyond those the UI/UX audit has (ORR-735). A file of its own,
// with wcag-light.spec.ts the other mode's, as a walk takes minutes and a shard takes whole files (ORR-920).

let w: Walked

test.beforeAll(async ({request}) => {
    w = await walkProject(request, 'Orb', 'ORB')
})

wcagWalk('no page breaks a WCAG A or AA rule in dark mode, beyond those the UI/UX audit has (ORR-735)', () => w, 'dark')
