// `PATCH /api/projects/:project/doc-sections/:section` {name?, position?} → {name}: renames it on every doc in it, or moves it in the list (0 the top).
export default defineEventHandler(async event => ({name: await useStore().updateDocSection(param(event, 'project'), param(event, 'section'), await readBody(event))}))
