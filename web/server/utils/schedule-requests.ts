// The chat asking the owner for a schedule (chats.ts `askSchedule`): the request checked as Schedules would check it for
// the owner, and nothing saved until they allow it; then the schedule is theirs, and it runs. A working session's ask on
// its issue (ORR-458), and the owner's answer to it, are the Rust API's (`work/schedule_requests.rs`, ORR-1162).
import type {ChatScheduleField, ChatScheduleRequest, Schedule, ChatRequestDrift} from '#shared/roadmap'
import {CHAT_SCHEDULE_FIELDS, scheduleValue} from '#shared/roadmap'
import type {Actor} from '../store/schema'
import {isObject} from './input'

/** The names of the presets `ids`, those that are still there. */
async function presetNames(project: string, ids: unknown[]): Promise<Map<unknown, string>> {
    if (!ids.length) return new Map()
    return new Map((await useStore().presets(project)).filter(p => ids.includes(p.id)).map(p => [p.id, p.name]))
}

/** A request to make a schedule in `project`, or change schedule `target` there: `fields` as Schedules takes them
 * (`CHAT_SCHEDULE_FIELDS`; `enabled` pauses or resumes one), checked as Schedules would check them for `owner`, each
 * shown from → to. `who` asks, for the refusal. Saves nothing. */
export async function scheduleRequest(project: string, fields: unknown, target: unknown, owner: Actor, who: string): Promise<ChatScheduleRequest> {
    if (!isObject(fields) || !Object.keys(fields).length) throw badRequest(`Send {schedule: {…}, id?}: the fields to set, any of ${Object.keys(CHAT_SCHEDULE_FIELDS).join(', ')}, and the schedule's id to change one`)
    const refused = Object.keys(fields).filter(key => !Object.hasOwn(CHAT_SCHEDULE_FIELDS, key))
    if (refused.length) throw forbidden(`${who} sets a schedule's ${Object.keys(CHAT_SCHEDULE_FIELDS).join(', ')}, not its ${refused.join(', ')}: the rest are the owner's to set on Schedules`)
    if (target !== undefined && target !== null && !Number.isInteger(target)) throw badRequest('Send "id" as the number of the schedule to change, or leave it out to make one')
    const scheduler = useScheduler()
    const current = Number.isInteger(target) ? await scheduler.get(project, target as number) : undefined
    await scheduler.check(project, fields, owner, current?.id)
    const presets = await presetNames(project, [...(fields.presets as number[] | undefined) ?? [], ...current?.presets ?? []])
    const shown = (field: ChatScheduleField, value: unknown) => field === 'presets' && Array.isArray(value) ? value.map(p => presets.get(p) ?? p) : value
    const changes = (Object.entries(fields) as [ChatScheduleField, unknown][]).map(([field, to]) =>
        current ? {field, from: shown(field, current[field as keyof Schedule] ?? null), to: shown(field, to)} : {field, to: shown(field, to)})
    return {...current ? {id: current.id} : {}, title: String(fields.title ?? current?.title ?? ''), changes, body: fields, state: 'asked'}
}

/** What has changed on a schedule since a request to change it was asked, field by field (ORR-645). One deleted since has
 * nothing to compare: Allow fails on it as Schedules would. */
export async function scheduleDrift(project: string, request: ChatScheduleRequest): Promise<ChatRequestDrift[]> {
    if (request.id === undefined) return []
    const current = await useScheduler().get(project, request.id).catch(() => null)
    if (!current) return []
    const presets = await presetNames(project, current.presets ?? [])
    return request.changes.flatMap(c => {
        if (c.from === undefined) return []
        const value = current[c.field as keyof Schedule] ?? null
        const now = c.field === 'presets' && Array.isArray(value) ? value.map(p => presets.get(p) ?? p) : value
        return JSON.stringify(c.from) === JSON.stringify(now) ? [] : [{label: CHAT_SCHEDULE_FIELDS[c.field], from: scheduleValue(c.from), to: scheduleValue(now)}]
    })
}

/** What a schedule request asks, as a line: "make the schedule X", "change schedule 3 (X)". */
export const scheduleAsk = (request: ChatScheduleRequest) => request.id === undefined
    ? `make the schedule "${request.title}"`
    : `change schedule ${request.id} ("${request.title}"): ${request.changes.map(c => `${CHAT_SCHEDULE_FIELDS[c.field]} to ${scheduleValue(c.to)}`).join(', ')}`
