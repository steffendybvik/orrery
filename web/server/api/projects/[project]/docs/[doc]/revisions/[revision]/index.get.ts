// `GET /api/projects/:project/docs/:doc/revisions/:revision` → that revision with its Markdown.
export default defineEventHandler(async event => useStore().docRevision(param(event, 'project'), param(event, 'doc'), Number(param(event, 'revision'))))
