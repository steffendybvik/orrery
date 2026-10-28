import type {Schedule} from '#shared/roadmap'

// Every project's schedules, by project, kept current from `/api/events`; and the schedule dialog
// (open for a project, and a schedule to edit, or a new one filled in from a suggestion), the right-click menu, and pausing one.
export function useSchedules() {
    const byProject = useState<Record<string, Schedule[]>>('schedules', () => ({}))
    const of = (project: string) => byProject.value[project] ?? []

    async function load() {
        const list = await $fetch<Schedule[]>('/api/schedules').catch(() => [] as Schedule[])
        byProject.value = Object.groupBy(list, s => s.project) as Record<string, Schedule[]>
    }

    const editing = useState<{project: string, schedule?: Schedule, draft?: Partial<Schedule>} | null>('schedule-dialog', () => null)
    const edit = (project: string, schedule?: Schedule, draft?: Partial<Schedule>) => editing.value = {project, schedule, draft}

    const menu = useState<{schedule: Schedule, x: number, y: number} | null>('schedule-menu', () => null)
    function openMenu(event: MouseEvent, schedule: Schedule) {
        event.preventDefault()
        menu.value = {schedule, x: event.clientX, y: event.clientY}
    }

    /** Pauses a schedule, or resumes it, as the owner; the list catches up from the events. */
    async function pause(schedule: Schedule, paused: boolean) {
        await $fetch<Schedule>(`/api/projects/${encodeURIComponent(schedule.project)}/schedules/${schedule.id}`, {
            method: 'PATCH', headers: {'Orrery-Actor': await useOwner().load()}, body: {enabled: !paused},
        })
    }

    return {byProject, of, load, editing, edit, menu, openMenu, pause}
}
