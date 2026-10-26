// `POST /api/projects/:project/issues/decide` {ids, decision, note?} → `[{id, ok, error?}]`: the owner's one
// decision on many proposals. Approving takes each one's recommended picks, skipping one that has none.
export default defineEventHandler(async event => useStore().decideIssues(param(event, 'project'), await readBody(event).catch(() => ({})), await actorOf(event)))
