// `GET /api/projects/:project/milestones/:milestone` → the milestone with its issues.
export default defineEventHandler(async event => useStore().milestone(param(event, 'project'), param(event, 'milestone')))
