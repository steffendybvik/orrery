// `GET /api/projects/:project/docs/:doc/revisions` → its revisions, newest first, without their text; a deleted doc's too.
export default defineEventHandler(async event => useStore().docRevisions(param(event, 'project'), param(event, 'doc')))
