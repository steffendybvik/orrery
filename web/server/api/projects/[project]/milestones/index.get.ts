// `GET /api/projects/:project/milestones` → its milestones, with their columns, counts and top-level issue ids.
export default defineEventHandler(async event => useStore().listMilestones(param(event, 'project')))
