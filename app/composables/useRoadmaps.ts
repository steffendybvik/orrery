import type {Project} from '#shared/roadmap'

// Every project with its board, loaded once and kept current by `/api/events` (see the
// `roadmaps` plugin). `changed` holds the ids of issues that just changed, so rows can flash.
export function useRoadmaps() {
    const projects = useState<Project[]>('projects', () => [])
    const ready = useState('projects-ready', () => false)
    const live = useState<'connecting' | 'live' | 'offline'>('projects-live', () => 'connecting')
    const changed = useState<Record<string, number>>('projects-changed', () => ({}))

    const byId = (id: string | undefined) => projects.value.find(p => p.id === id)
    return {projects, ready, live, changed, byId}
}
