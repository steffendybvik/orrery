// A session asking the owner for a schedule: the chat in its chat (chats.ts `askSchedule`), and a working session on
// the issue it's working (ORR-458), as a comment waiting on the owner's decision with Allow and Deny. Either way the
// request is checked as Schedules would check it for the owner, and nothing is saved until they allow it; then the
// schedule is theirs, and it runs.
import type {ChatScheduleField, ChatScheduleRequest, Comment, Schedule} from '#shared/roadmap'
import {CHAT_SCHEDULE_FIELDS, scheduleValue} from '#shared/roadmap'
import type {Actor} from '../store/schema'
import {isObject} from './input'
import {ownerOnly} from './permission'

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

/** What a schedule request asks, as a line: "make the schedule X", "change schedule 3 (X)". */
export const scheduleAsk = (request: ChatScheduleRequest) => request.id === undefined
    ? `make the schedule "${request.title}"`
    : `change schedule ${request.id} ("${request.title}"): ${request.changes.map(c => `${CHAT_SCHEDULE_FIELDS[c.field]} to ${scheduleValue(c.to)}`).join(', ')}`

/** A working session asking the owner, on the issue it's working, to make a schedule or change one (its
 * `create_schedule` and `update_schedule` tools): `body` is `{schedule, id?, why?}` as the chat sends it. A comment
 * waiting on the owner's decision, with the request beside it; the owner's answer comes back as their comment. */
export async function askScheduleOn(project: string, issue: string, body: unknown, actor: Actor): Promise<Comment> {
    if (actor.owner) throw badRequest('The owner makes and changes schedules on Schedules: this is for a session to ask them')
    const {schedule: fields, id: target, why} = (isObject(body) ? body : {}) as {schedule?: unknown, id?: unknown, why?: unknown}
    const store = useStore()
    const request = await scheduleRequest(project, fields, target, {name: (await store.ownerOf()).name, owner: true}, 'A session')
    const words = [typeof why === 'string' ? why.trim() : '', `Asks to ${scheduleAsk(request)}. Nothing is saved until you press Allow.`]
    const comment = await store.askForSchedule(project, issue, words.filter(Boolean).join('\n\n'), request, actor)
    useEventLog().note({level: 'info', kind: 'schedule.asked', project, message: `${actor.session ?? actor.name} asked on ${comment.issue} to ${scheduleAsk(request)}`,
        details: {issue: comment.issue, schedule: request.id ?? null, fields: Object.keys(request.body)}})
    return comment
}

/** Requests being answered now, by their comment's id: a second click doesn't save the schedule twice. */
const answering = new Set<number>()

/** The owner allowing or denying the schedule request comment `id` holds: allowed, the schedule is made or changed as
 * theirs. Either way their answer is a comment of theirs, which answers the ask and reaches the session. 409 once
 * answered, or expired by a later request for the same schedule; one that no longer holds (its preset deleted since)
 * fails as Schedules would, still asked. */
export async function answerScheduleRequest(project: string, issue: string, id: number, allow: boolean, actor: Actor): Promise<Comment> {
    ownerOnly(actor, 'schedules.answer')
    const store = useStore()
    const request = await store.scheduleRequest(project, issue, id)
    if (request.state !== 'asked') throw conflict(`That request is ${request.state} already${request.state === 'expired' ? ': it was asked again since' : ''}`)
    if (answering.has(id)) throw conflict('That request is being answered already')
    answering.add(id)
    try {
        let made: Schedule | undefined
        if (allow) {
            made = request.id === undefined
                ? await useScheduler().create(project, request.body, actor)
                : await useScheduler().update(project, request.id, request.body, actor)
        }
        await store.answerScheduleRequest(project, id, allow ? 'allowed' : 'denied', made?.id, actor)
        useEventLog().note({level: 'info', kind: 'schedule.answered', project, message: `${actor.name} ${allow ? 'allowed' : 'denied'} the request on ${issue} to ${scheduleAsk(request)}`,
            details: {issue, schedule: made?.id ?? request.id ?? null, fields: Object.keys(request.body), allowed: allow}})
        await store.createComment(project, issue, {body: made
            ? `Allowed: schedule ${made.id} ("${made.title}") is saved as mine${made.enabled ? '' : ', paused'}.`
            : `Denied: don't ${scheduleAsk(request)}. Nothing changed.`}, actor)
    } finally {
        answering.delete(id)
    }
    // From the list, which knows the ask is answered now.
    return (await store.listComments(project, issue)).find(c => c.id === id) as Comment
}
