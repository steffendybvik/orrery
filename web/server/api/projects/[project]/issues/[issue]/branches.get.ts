// `GET /api/projects/:project/issues/:issue/branches` → {repo, base, branches, error?}: the branches the issue's work can carry
// on from, so a session picks one up rather than leaving it stale (ORR-799). Names are held to `SAFE_BRANCH`.
export default defineEventHandler(async event => useBranches().forIssue(param(event, 'project'), param(event, 'issue'), sessionHeader(event)))
