// `GET /api/connects/:connect` → the request as it stands, which the page follows.
export default defineEventHandler(event => connectOf(param(event, 'connect')))
