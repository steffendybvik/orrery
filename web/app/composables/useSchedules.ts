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

    /** Pauses a schedule, or resumes it, as the owner; the list catches up from the events. Their own change isn't news. */
    async function pause(schedule: Schedule, paused: boolean) {
        useUnseen().seeSchedule(await $fetch<Schedule>(`/api/projects/${encodeURIComponent(schedule.project)}/schedules/${schedule.id}`, {
            method: 'PATCH', headers: {'Orrery-Actor': await useOwner().load()}, body: {enabled: !paused},
        }))
    }

    /** Makes an agent's schedule the owner's, as they read it (`updated_at`): it runs as theirs from then on (ORR-456). */
    async function adopt(schedule: Schedule): Promise<Schedule> {
        const mine = await $fetch<Schedule>(`/api/projects/${encodeURIComponent(schedule.project)}/schedules/${schedule.id}/adopt`, {
            method: 'POST', headers: {'Orrery-Actor': await useOwner().load()}, body: {seen: schedule.updated_at},
        })
        useUnseen().seeSchedule(mine)
        return mine
    }

    return {byProject, of, load, editing, edit, menu, openMenu, pause, adopt}
}
