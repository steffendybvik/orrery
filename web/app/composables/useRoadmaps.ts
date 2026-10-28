import type {Project, Session, Signal} from '#shared/roadmap'

// Every project with its board (without the issues' notes: an issue's page reads its own), loaded once and kept current by `/api/events` (see the
// `roadmaps` plugin). The first load leaves closed issues out (ORR-447): a project is read whole as one of its pages opens.
// `changed` holds the ids of issues that just changed, so rows can flash.
export function useRoadmaps() {
    const projects = useState<Project[]>('projects', () => [])
    const ready = useState('projects-ready', () => false)
    const live = useState<'connecting' | 'connected' | 'reconnecting' | 'offline'>('projects-live', () => 'connecting')
    const changed = useState<Record<string, number>>('projects-changed', () => ({}))
    /** How many Claude sessions listen for each project's signals (known for projects asked about). */
    const listeners = useState<Record<string, number>>('projects-listeners', () => ({}))
    /** How many launchers that start sessions are connected for each project (known once one comes or goes). */
    const launchers = useState<Record<string, number>>('projects-launchers', () => ({}))
    /** The Claude sessions on each project, as their hooks and channels last said. Not the owner's chats: they count
     * towards nothing and aren't listed, so they're kept apart, in `chatSessions` (the chat pane's). */
    const sessions = useState<Record<string, Session[]>>('projects-sessions', () => ({}))
    const chatSessions = useState<Record<string, Session[]>>('projects-chat-sessions', () => ({}))
    /** Signals as they're sent and delivered, latest first (what the issue pages show). */
    const signals = useState<Signal[]>('projects-signals', () => [])
    /** The projects read without their closed issues, which a page of theirs reads whole (`whole`). */
    const partial = useState<Record<string, boolean>>('projects-partial', () => ({}))

    const byId = (id: string | undefined) => projects.value.find(p => p.id === id)
    /** Loads one project afresh and puts it in place: for when its update hasn't come yet (a page opened right
     * after a write), or won't (offline). Nothing when it can't be loaded. */
    async function reload(id: string): Promise<Project | undefined> {
        const project = await $fetch<Project>(`/api/projects/${encodeURIComponent(id)}`, {query: {notes: '0'}}).catch(() => undefined)
        if (project) {
            if (partial.value[id]) partial.value = {...partial.value, [id]: false}
            projects.value = byId(id) ? projects.value.map(p => p.id === id ? project : p)
                : [...projects.value, project].sort((a, b) => a.name.localeCompare(b.name))
        }
        return project
    }
    /** Reads the project whole, closed issues and all, if the page has it without them. */
    const reading = new Map<string, Promise<unknown>>()
    function whole(id: string): Promise<unknown> {
        if (!partial.value[id]) return Promise.resolve()
        const read = reading.get(id) ?? reload(id).finally(() => reading.delete(id))
        reading.set(id, read)
        return read
    }
    return {projects, ready, live, changed, listeners, launchers, sessions, chatSessions, signals, partial, byId, reload, whole}
}
