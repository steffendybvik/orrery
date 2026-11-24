import type {ProjectSummary} from '../../../store/schema'

// `POST /api/connects/:connect/write {projects}` → the request: the projects the chosen folder holds, ticked by the owner, to
// add to it. Its launcher writes the files there and opens Claude in it. 409 until a folder is chosen.
export default defineEventHandler(async event => {
    await authorize(event, 'connects.start')
    const store = useStore()
    const {projects} = checkInput(await readBody(event), {projects: {type: 'strings', required: true}})
    const named = [...new Set((projects as unknown[]).map(String))]
    // Only projects the asker sees, in the workspace they're acting in (ORR-1375): any other is the same 404 as one
    // that isn't here, so a connect can't confirm another workspace's ids or write its keys into a folder.
    const workspace = await askerWorkspace(event)
    const all = await store.listProjects()
    const found: ProjectSummary[] = []
    for (const id of named) {
        const project = all.find(p => p.id === id)
        if (!project) notFoundProject(id)
        await seenProjectOf(event, id).catch(() => notFoundProject(id))
        if (workspace !== undefined && await store.projectWorkspace(id) !== workspace) notFoundProject(id)
        found.push(project)
    }
    const settings = await settingsNow()
    return writeConnect(param(event, 'connect'), found.map(p => ({id: p.id, key: p.key})), {id: settings.id, environment: String(useRuntimeConfig().public.environment || 'personal')}, settings.terminal)
})

function notFoundProject(id: string): never {
    throw notFound(`No project ${id}`)
}
