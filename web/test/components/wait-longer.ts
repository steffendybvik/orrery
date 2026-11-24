import {vi} from 'vitest'

// `vi.waitFor` gives up after a second, which a busy machine running the whole suite can pass with nothing wrong
// (ORR-1354): a wait in a component test that names no timeout gets five. One that names its own keeps it.
const waitFor = vi.waitFor.bind(vi)
vi.waitFor = ((callback, options) => waitFor(callback, typeof options === 'number' ? options : {timeout: 5000, ...options})) as typeof vi.waitFor
