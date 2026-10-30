// `POST /api/connects/:connect/write {projects}` → the request: the projects the chosen folder holds, ticked by the owner, to
// add to it. Its launcher writes the files there and opens Claude in it. 409 until a folder is chosen.
export default defineEventHandler(async event => {
    await authorize(event, 'connects.start')
    const store = useStore()
    const {projects} = checkInput(await readBody(event), {projects: {type: 'strings', required: true}})
    const named = [...new Set((projects as unknown[]).map(String))]
    const all = await store.listProjects()
    const found = named.map(id => all.find(p => p.id === id) ?? notFoundProject(id))
    const settings = await store.settings()
    return writeConnect(param(event, 'connect'), found.map(p => ({id: p.id, key: p.key})), {id: settings.id, environment: String(useRuntimeConfig().public.environment || 'personal')}, settings.terminal)
})

function notFoundProject(id: string): never {
    throw notFound(`No project ${id}`)
}
