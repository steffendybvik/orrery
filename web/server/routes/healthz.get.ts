// `GET /healthz` → {ok}: for the container's health check, which has no credential, so it says nothing but that it's up.
export default defineEventHandler(() => ({ok: true}))
