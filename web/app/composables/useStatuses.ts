import type {Column, Place} from '#shared/roadmap'
import {TINTS} from '#shared/roadmap'

/** How a column looks: its name, what it means and its colour. */
export interface Look {
    id: Column
    label: string
    kind: Place
    color: string
}

const PROPOSED: Look = {id: 'proposed', label: 'Proposed', kind: 'proposed', color: TINTS.amber}

// The Orrery's issue statuses, from its settings (kept current from `/api/events`), as the columns
// the board draws: `places` in the order an issue moves through them (Proposed first), `columns` as the
// boards and lists show them, what's started first and what's closed last.
export function useStatuses() {
    const {settings} = useAppSettings()
    const statuses = computed(() => settings.value.statuses ?? [])
    const looks = computed(() => new Map<Column, Look>([
        ['proposed', PROPOSED],
        ...statuses.value.map(s => [s.id, {id: s.id, label: s.name, kind: s.kind, color: colorOf(s.color)}] as [Column, Look]),
    ]))
    const look = (column: Column): Look => looks.value.get(column) ?? {id: column, label: column, kind: 'backlog', color: TINTS.slate}
    const of = (...kinds: Place[]) => kinds.flatMap(kind => [...looks.value.values()].filter(l => l.kind === kind))
    const places = computed(() => of('proposed', 'backlog', 'todo', 'started', 'done', 'canceled'))
    const columns = computed(() => of('started', 'todo', 'backlog', 'proposed', 'done', 'canceled'))
    return {statuses, look, places, columns}
}
