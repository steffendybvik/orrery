// `PATCH /api/projects/:project/issues` {ids, set?: {status?, priority?, assignee?, chunk?, release?}, labels?: {add?, remove?}}
// → `[{id, ok, error?}]`: one change to many issues, each on its own, so one refused doesn't stop the rest.
export default defineEventHandler(async event => useStore().updateIssues(param(event, 'project'), await readBody(event).catch(() => ({})), await actorOf(event)))
