// `GET /healthz` → {ok}: for the container's health check, which has no credential, so it says nothing but whether it's
// up. Up means the Rust API answers too (ORR-1188): with it down every board request fails, so this answers 503 then,
// for Docker or whatever watches the health to restart it.
import {apiAnswers, apiTarget} from '../utils/api-router'

export default defineEventHandler(async event => {
    const api = apiTarget(useRuntimeConfig())
    if (api && await apiAnswers(api.url)) return {ok: true}
    setResponseStatus(event, 503)
    return {ok: false}
})
