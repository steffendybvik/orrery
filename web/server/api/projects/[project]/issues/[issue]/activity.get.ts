// `GET /api/projects/:project/issues/:issue/activity` → who changed what on it, and when, oldest first.
export default defineEventHandler(async event => useStore().listActivity(param(event, 'project'), param(event, 'issue')))
