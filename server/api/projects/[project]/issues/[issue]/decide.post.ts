// `POST /api/projects/:project/issues/:issue/decide` {decision, note?} → the issue: the owner approves the
// proposal, asks for changes, or rejects it. Approving doesn't commit it: `PATCH {proposal: null}` does.
export default defineEventHandler(async event => useStore().decide(param(event, 'project'), param(event, 'issue'), await readBody(event).catch(() => ({})), actorOf(event)))
