import type {Schedule, ScheduleAcross} from '#shared/roadmap'

// Every project's schedules, by project, kept current from `/api/events`; and the schedule dialog
// (open for a project, and a schedule to edit, or a new one filled in from a suggestion), the right-click menu, and pausing one.
// And the schedules across projects (ORR-638): one made from one opens that to edit.
export function useSchedules() {
    const byProject = useState<Record<string, Schedule[]>>('schedules', () => ({}))
    const of = (project: string) => byProject.value[project] ?? []
    const across = useState<ScheduleAcross[]>('schedules-across', () => [])
    async function loadAcross() {
        across.value = await apiFetch<ScheduleAcross[]>('/schedules/across').catch(() => across.value)
    }

    async function load() {
        const list = await apiFetch<Schedule[]>('/schedules').catch(() => [] as Schedule[])
        byProject.value = Object.groupBy(list, s => s.project) as Record<string, Schedule[]>
        await loadAcross()
    }

    const editing = useState<{project: string, schedule?: Schedule, draft?: Partial<Schedule>, across?: ScheduleAcross} | null>('schedule-dialog', () => null)
    function edit(project: string, schedule?: Schedule, draft?: Partial<Schedule>) {
        const from = schedule?.across && across.value.find(a => a.id === schedule.across)
        editing.value = from ? {project, across: from} : {project, schedule, draft}
    }
    const editAcross = (from: ScheduleAcross) => editing.value = {project: '', across: from}

    const menu = useState<{schedule: Schedule, x: number, y: number} | null>('schedule-menu', () => null)
    function openMenu(event: MouseEvent, schedule: Schedule) {
        event.preventDefault()
        menu.value = {schedule, x: event.clientX, y: event.clientY}
    }

    /** Pauses a schedule, or resumes it, as the owner; the list catches up from the events. Their own change isn't news. */
    async function pause(schedule: Schedule, paused: boolean) {
        useUnseen().seeSchedule(await apiFetch<Schedule>(`/projects/${encodeURIComponent(schedule.project)}/schedules/${schedule.id}`, {
            method: 'PATCH', body: {enabled: !paused},
        }))
    }

    /** Makes an agent's schedule the owner's, as they read it (`updated_at`): it runs as theirs from then on (ORR-456). */
    async function adopt(schedule: Schedule): Promise<Schedule> {
        const mine = await apiFetch<Schedule>(`/projects/${encodeURIComponent(schedule.project)}/schedules/${schedule.id}/adopt`, {
            method: 'POST', body: {seen: schedule.updated_at},
        })
        useUnseen().seeSchedule(mine)
        return mine
    }

    return {byProject, of, load, across, loadAcross, editing, edit, editAcross, menu, openMenu, pause, adopt}
}
