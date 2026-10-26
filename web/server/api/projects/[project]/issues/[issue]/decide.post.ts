// `POST /api/projects/:project/issues/:issue/decide` {decision, note?} → the issue: the owner approves the
// proposal, asks for changes, or rejects it. Approving commits it, into Todo.
export default defineEventHandler(async event => useStore().decide(param(event, 'project'), param(event, 'issue'), await readBody(event).catch(() => ({})), await actorOf(event)))
