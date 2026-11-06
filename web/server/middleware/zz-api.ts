// Sends the routes the Rust API serves to it, when there is one (ORR-922, `routeToApi`). Named to run last, after every
// check the other middleware make, so a request reaches the API only once this server would have let it through. With
// the swap on (NUXT_API_ONLY, ORR-1034), a request it can't answer fails here instead of going on to the routes.
import {routeToApi} from '../utils/api-router'

export default defineEventHandler(async event => {
    const reply = await routeToApi(event, useRuntimeConfig())
    // A middleware that returns anything answers the request; undefined goes on to the routes here.
    if (reply !== undefined) return reply
})
