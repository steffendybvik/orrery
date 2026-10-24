import type {Issue, Project} from '#shared/roadmap'

// Loads the projects, then listens to `/api/events`: a change through the API replaces that
// project in place, without a reload. After a dropped connection it loads them all again.
export default defineNuxtPlugin(() => {
    const {projects, ready, live, changed} = useRoadmaps()

    async function load() {
        projects.value = await $fetch<Project[]>('/api/projects', {query: {expand: 'board'}})
        ready.value = true
    }

    /** The issues whose `updatedAt` moved, so their rows can flash. */
    function markChanged(before: Project | undefined, after: Project) {
        const stamps = new Map<string, string>()
        const walk = (issues: Issue[], visit: (issue: Issue) => void) => issues.forEach(i => {
            visit(i)
            walk(i.tasks, visit)
        })
        before?.board.chunks.forEach(c => walk(c.tasks, i => stamps.set(i.id, i.updatedAt)))
        const now = Date.now()
        const next = {...changed.value}
        after.board.chunks.forEach(c => walk(c.tasks, i => {
            if (before && stamps.get(i.id) !== i.updatedAt) next[`${after.id}/${i.id}`] = now
        }))
        changed.value = next
    }

    let opened = false
    function connect() {
        const events = new EventSource('/api/events')
        events.addEventListener('open', () => {
            live.value = 'live'
            if (opened) load()
            opened = true
        })
        events.addEventListener('ready', event => {
            const build = (event as MessageEvent).data as string
            if (build && build !== useRuntimeConfig().app.buildId) location.reload()
        })
        events.addEventListener('error', () => {
            live.value = events.readyState === EventSource.CLOSED ? 'offline' : 'connecting'
        })
        events.addEventListener('project', event => {
            const project = JSON.parse((event as MessageEvent).data) as Project
            const index = projects.value.findIndex(p => p.id === project.id)
            markChanged(projects.value[index], project)
            if (index < 0) projects.value = [...projects.value, project].sort((a, b) => a.name.localeCompare(b.name))
            else projects.value = projects.value.map(p => p.id === project.id ? project : p)
        })
        events.addEventListener('removed', event => {
            const id = (event as MessageEvent).data as string
            projects.value = projects.value.filter(p => p.id !== id)
        })
    }

    load().catch(() => {
        ready.value = true
    })
    connect()
})
