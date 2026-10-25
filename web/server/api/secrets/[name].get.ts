// `GET /api/secrets/:name` → the secret (never its value) with its latest uses.
export default defineEventHandler(async event => useSecrets().get(param(event, 'name')))
