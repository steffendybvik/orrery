// `POST /api/projects/:project/doc-sections` {name} → 201 {name}: a section with no docs in it yet.
export default defineEventHandler(async event => created(event, {name: await useStore().createDocSection(param(event, 'project'), await readBody(event))}))
