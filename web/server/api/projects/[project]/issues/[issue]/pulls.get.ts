// `GET /api/projects/:project/issues/:issue/pulls` → {repo, pulls, error?, token, checked_at}: the open pull requests on
// the project's GitHub repo that name the issue (a link to its page in the body, or its id in the branch), with where
// each stands. GitHub is asked at most once a minute (five without a GITHUB_TOKEN secret); in between it's what it said last.
// Anyone but the owner gets each PR without what an outsider may have written (ORR-532).
export default defineEventHandler(async event => pullsForAsker(event, await usePulls().forIssue(param(event, 'project'), param(event, 'issue'))))
