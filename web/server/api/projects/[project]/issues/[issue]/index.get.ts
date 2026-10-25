// `GET /api/projects/:project/issues/:issue` → the issue with its column, counts and sub-issues.
export default defineEventHandler(async event => useStore().issue(param(event, 'project'), param(event, 'issue')))
