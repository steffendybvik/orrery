// `GET /api/projects/:project/sessions` → the Claude sessions working on the project.
export default defineEventHandler(async event => listSessions(param(event, 'project')))
