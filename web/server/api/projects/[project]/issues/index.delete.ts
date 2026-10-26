// `DELETE /api/projects/:project/issues` {ids} → `[{id, ok, error?}]`: many issues deleted, each with its
// sub-issues and comments, under the same protections as one.
export default defineEventHandler(async event => useStore().deleteIssues(param(event, 'project'), await readBody(event).catch(() => ({})), await actorOf(event)))
