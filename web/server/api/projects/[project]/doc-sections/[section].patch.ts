// `PATCH /api/projects/:project/doc-sections/:section` {name} → {name}: renames it on every doc in it.
export default defineEventHandler(async event => ({name: await useStore().renameDocSection(param(event, 'project'), param(event, 'section'), await readBody(event))}))
