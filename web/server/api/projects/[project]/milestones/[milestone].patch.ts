// `PATCH /api/projects/:project/milestones/:milestone` {title?, summary?, position?} → the milestone.
export default defineEventHandler(async event => useStore().updateMilestone(param(event, 'project'), param(event, 'milestone'), await readBody(event)))
