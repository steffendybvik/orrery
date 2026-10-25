// `PATCH /api/projects/:project/issues/:issue` {title?, status?, plan?, priority?, assignee?, labels?, notes?,
// proposal?, parent?, chunk?, project?, position?} → the issue. Null clears plan, priority, assignee, labels, notes,
// parent and chunk, and commits a proposal; `project` moves it, with its sub-issues and comments, to another project.
export default defineEventHandler(async event => useStore().updateIssue(param(event, 'project'), param(event, 'issue'), await readBody(event), actorOf(event)))
