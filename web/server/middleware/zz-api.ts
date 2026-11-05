// Sends the routes the Rust API serves to it, when there is one (ORR-922, `forwardToApi`). Named to run last, after every
// check the other middleware make, so a request reaches the API only once this server would have let it through.
import {apiTarget, forwardToApi, servedByApi} from '../utils/api-router'
import {pathOf} from '../utils/auth'

export default defineEventHandler(async event => {
    const api = apiTarget(useRuntimeConfig())
    if (!api || !servedByApi(event.method, pathOf(event))) return
    const reply = await forwardToApi(event, api)
    // A middleware that returns anything answers the request; undefined goes on to the routes here.
    if (reply !== undefined) return reply
})
