// `GET /api/projects/:project/milestones/:milestone/comments` → its comments, oldest first (ORR-977).
export default defineEventHandler(async event => useStore().listMilestoneComments(param(event, 'project'), param(event, 'milestone')))
