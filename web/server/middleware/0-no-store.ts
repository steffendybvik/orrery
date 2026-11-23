// The API's answers are one person's, so the browser keeps none of them (ORR-1391): the next person on it, or Back
// after logging out, never gets one from its cache. A reply that says otherwise, such as an uploaded image, which
// never changes, sets its own as it goes through.
import {pathOf} from '../utils/auth'

export default defineEventHandler(event => {
    const path = pathOf(event)
    if (path === '/api' || path.startsWith('/api/')) setResponseHeader(event, 'Cache-Control', 'no-store')
})
