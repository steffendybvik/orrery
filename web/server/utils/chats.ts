import type {H3Event} from 'h3'
import type {Chat, ChatIssues, ChatMessage, ChatScheduleField, ChatScheduleRequest, ChatSendRequest, ChatSetting, Schedule, SessionState} from '#shared/roadmap'
import {CHAT_ISSUES, CHAT_SCHEDULE_FIELDS, CHAT_SETTINGS, SESSION_STATES, scheduleValue, settingValue} from '#shared/roadmap'
import type {Actor} from '../store/schema'
import {SETTINGS_FIELDS} from '../store/schema'
import {checkInput, isObject} from './input'
import {known} from '#shared/known'

// The owner's chats: a Claude session started for one alone (launches.ts `startChat`), which the owner talks to on the
// page instead of in a terminal. It answers questions about the project and makes issues and comments when asked;
// it works on nothing (middleware/chat.ts holds its writes to that, and it hears only the chat). The owner's words go
// to it as messages aimed at it; it answers with its channel's `reply` tool, kept here and streamed to the page
// (`chat` events). A chat is kept while its session runs, here only, and ends when the owner ends it.

/** What the chat's session on `project` is told it is, with every message. */
const chatBrief = (project: string) => `This session is the owner's chat in orrery: they type to you on its page and read what you send with the reply tool.
Answer their questions about this project: its code (read it), its roadmap and its docs (the issues, issue, chunks,
releases, docs and doc tools). When they ask for an issue or a comment, make it (create_issue, comment) and say which
id it got. When they ask to change an issue (its priority, labels, chunk, release, title…), change it (edit_issue). You
don't work on anything: don't change code, and don't start, move or finish issues; other sessions do that. When the owner asks you to, in this chat, message other sessions (sessions lists them): message_sessions
asks to nudge every idle one, message_session one by its name. Either shows them the message and who it goes to with
Send and Don't send, and you hear which they pressed: nothing is sent until they press Send. Never on your own.
When the owner asks you to change an App setting (the team tracker, the background tint, keeping agents off
proposals, their handle, Advanced), ask with update_settings, one setting at a time: it shows them the change with
Allow and Deny, and you hear which they pressed. Nothing is saved until they allow it. Never on your own.
When the owner asks you to set up a schedule or change one (pause, resume, its time, its message…), ask with
create_schedule or update_schedule (the schedules tool lists them): it shows them the schedule with Allow and Deny, the
same way. Never on your own, and never to delete one: that's theirs, on the Schedules page.
Every answer goes back with the reply tool, in Markdown: nothing else reaches the owner. Write an issue as a link
to its page, \`[<id>](/p/${project}/issues/<id>)\`, so the owner can open it.
A message ends with the page the owner had open when they wrote it, e.g. \`(The owner is on /p/${project}/schedules: Schedules.)\`.
It's a hint for "this" and "here": before answering about it, read what's on that page with the matching tool (issue,
doc, chunks, releases, schedules, sessions, presets, events).`

const chats = new Map<string, Chat>()
let next = 1

function changed(chat: Chat) {
    projectEvents.emit('chat', chat)
}

/** Where `issues` says a chat's issues land; Todo when it says nothing. */
export function chatIssuesOf(issues: unknown): ChatIssues {
    if (issues === undefined || issues === null) return 'todo'
    if (!CHAT_ISSUES.includes(issues as ChatIssues)) throw badRequest(`"issues" is ${CHAT_ISSUES.map(i => `"${i}"`).join(' or ')}: where the issues the chat makes land`)
    return issues as ChatIssues
}

/** Starts a chat on the project, its issues landing in `issues`: its session is on its way, and the chat is there to
 * write in at once. */
export async function openChat(project: string, issues: ChatIssues = 'todo'): Promise<Chat> {
    const launch = await startChat(project, {presets: [], text: chatBrief(project)})
    const chat: Chat = {id: launch.id, project, started_at: new Date().toISOString(), messages: [], issues}
    chats.set(chat.id, chat)
    changed(chat)
    return chat
}

/** The chats running now, newest first. */
export const listChats = (): Chat[] => [...chats.values()].reverse()

export function chatOf(id: string): Chat {
    const chat = chats.get(id)
    if (!chat) throw notFound(`No chat ${id}: it has ended, or orrery restarted since`)
    return chat
}

function add(chat: Chat, message: Omit<ChatMessage, 'id' | 'at'>): ChatMessage {
    const said = {id: next++, at: new Date().toISOString(), ...message}
    chat.messages.push(said)
    changed(chat)
    return said
}

/** The page the owner is on as they write (`{path, title?}`), if it's one: a path on this orrery, and its tab's title. */
function pageOf(page: unknown): {path: string, title?: string} | undefined {
    if (page === undefined || page === null) return undefined
    const {path, title} = page as {path?: unknown, title?: unknown}
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.length > 500 || /[\s]/.test(path))
        throw badRequest('Send page as {path, title?}: the path of the page the owner is on, starting with /')
    const named = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
    return {path, ...named ? {title: named} : {}}
}

/** The owner writing in the chat, with the uploads they pasted (`images`, their ids) and the page they're on (`page`):
 * it goes to the chat's session alone, as a message from the owner, the page said at its end but not kept with it. */
export async function say(id: string, text: unknown, images: unknown, actor: {name: string, owner: boolean}, page?: unknown): Promise<ChatMessage> {
    const chat = chatOf(id)
    const words = typeof text === 'string' ? text.trim() : ''
    const pasted = Array.isArray(images) ? images.filter((i): i is string => typeof i === 'string' && /^[0-9a-f]{24}$/.test(i)) : []
    if (!words && !pasted.length) throw badRequest('Send {text, images?}: what to say, and the ids of any uploads pasted with it')
    if (Array.isArray(images) && pasted.length !== images.length) throw badRequest('Send images as the ids of uploads (POST /api/uploads)')
    const on = pageOf(page)
    const note = [
        words,
        pasted.length ? `(${pasted.length === 1 ? 'An image' : `${pasted.length} images`} pasted with this: ${pasted.join(', ')}. Look with the image tool.)` : '',
        on ? `(The owner is on ${on.path}${on.title ? `: ${on.title}` : ''}.)` : '',
    ].filter(Boolean).join('\n\n')
    await useStore().messageSession(chat.project, launchTarget(id), note, actor)
    return add(chat, {from: 'owner', text: words, images: pasted})
}

/** How long a request to change a setting waits on the owner's answer. */
export const ASK_FOR = 30 * 60_000

/** The chat's session asking the owner for something in its chat: a message sent to sessions (`{message, why?}`,
 * `askSend`), a schedule made or changed (`{schedule, id?, why?}`, `askSchedule`), or else an App setting changed
 * (`askSetting`). */
export async function ask(id: string, body: unknown): Promise<ChatMessage> {
    if (isObject(body) && 'message' in body) return await askSend(id, body)
    return isObject(body) && 'schedule' in body ? await askSchedule(id, body) : await askSetting(id, body)
}

/** The listening session `name` (its name or id, any case) that a chat may message: never a chat. An id it had before a
 * `/clear` finds it under its new one, as a request asked before it cleared keeps the old (ORR-480). */
function sessionNamed(name: string) {
    const wanted = currentId(name.trim()).toLowerCase()
    const session = listSessions().find(s => (s.id.toLowerCase() === wanted || s.name.toLowerCase() === wanted) && !chatSession(s.id))
    if (!session) throw notFound(`No session ${name}: the sessions tool lists them`)
    if (!hearing(session.project, session.id)) throw conflict(`${session.name} isn't listening, so a message can't reach it`)
    return session
}

/** The chat's session asking to message other sessions as the owner (its `message_session` and `message_sessions`
 * tools): `message` is `{text, session}` for one session by its name or id, or `{text, projects?, states?}` for every
 * listening one on (or hearing) `projects`, idle ones unless `states` says otherwise. A request in the chat, naming who
 * it would reach, which sends nothing until the owner presses Send: a chat's words never reach a session on its own
 * say, so text it read elsewhere can't be passed on as the owner's (ORR-416). */
export async function askSend(id: string, body: Record<string, unknown>): Promise<ChatMessage> {
    const chat = chatOf(id)
    const {message, why} = body as {message?: unknown, why?: unknown}
    const {text, session, projects, states} = (isObject(message) ? message : {}) as {text?: unknown, session?: unknown, projects?: unknown, states?: unknown}
    const words = typeof text === 'string' ? text.trim() : ''
    if (!words) throw badRequest('Send {message: {text, session}} for one session, or {message: {text, projects?, states?}} for every idle one')
    const list = (value: unknown, name: string) => {
        if (value === undefined || value === null) return undefined
        if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw badRequest(`Send ${name} as a list of strings`)
        return value as string[]
    }
    let request: ChatSendRequest
    if (session !== undefined && session !== null) {
        if (typeof session !== 'string' || projects !== undefined || states !== undefined) throw badRequest('Send "session" as one session\'s name or id, without projects or states')
        const one = sessionNamed(session)
        request = {text: words, session: one.id, project: one.project, to: [one.name], state: 'asked'}
    } else {
        const on = list(projects, 'projects')
        const wanted = list(states, 'states')
        const unknown = wanted?.find(s => !(SESSION_STATES as readonly string[]).includes(s))
        if (unknown) throw badRequest(`No session state ${unknown}: use ${SESSION_STATES.join(', ')}`)
        const to = recipients(on, wanted as SessionState[] | undefined)
        if (!to.length) throw conflict(`No ${wanted?.join(' or ') ?? 'idle'} session is listening${on?.length ? ` on ${on.join(', ')}` : ''}, so there's nobody to send it to`)
        request = {text: words, ...on?.length ? {projects: on} : {}, ...wanted ? {states: wanted as SessionState[]} : {}, to: to.map(s => s.name), state: 'asked'}
    }
    const said = add(chat, {from: 'claude', text: typeof why === 'string' ? why.trim() : '', images: [], send: request})
    useEventLog().note({level: 'info', kind: 'chat.asked', project: chat.project, message: `The chat asked to message ${request.to.join(', ')}`, details: {to: request.to}})
    return said
}

/** The owner, as their chat asks for them: who a schedule it asks for is checked as, and saved as. */
async function owner(): Promise<Actor> {
    return {name: (await useStore().ownerOf()).name, owner: true, via: 'chat'}
}

/** The chat's session asking to make a schedule in its project, or change schedule `id` there (its `create_schedule` and
 * `update_schedule` tools): `schedule` holds the fields, as Schedules takes them (`CHAT_SCHEDULE_FIELDS`; `enabled`
 * pauses or resumes one). A request in the chat, checked as Schedules would check it for the owner, which saves nothing
 * until they allow it. One it asked before for the same schedule, still unanswered, expires. */
async function askSchedule(id: string, body: Record<string, unknown>): Promise<ChatMessage> {
    const chat = chatOf(id)
    const {schedule: fields, id: target, why} = body as {schedule?: unknown, id?: unknown, why?: unknown}
    if (!isObject(fields) || !Object.keys(fields).length) throw badRequest(`Send {schedule: {…}, id?}: the fields to set, any of ${Object.keys(CHAT_SCHEDULE_FIELDS).join(', ')}, and the schedule's id to change one`)
    const refused = Object.keys(fields).filter(key => !Object.hasOwn(CHAT_SCHEDULE_FIELDS, key))
    if (refused.length) throw forbidden(`The owner's chat sets a schedule's ${Object.keys(CHAT_SCHEDULE_FIELDS).join(', ')}, not its ${refused.join(', ')}: the rest are the owner's to set on Schedules`)
    if (target !== undefined && target !== null && !Number.isInteger(target)) throw badRequest('Send "id" as the number of the schedule to change, or leave it out to make one')
    const scheduler = useScheduler()
    const current = Number.isInteger(target) ? await scheduler.get(chat.project, target as number) : undefined
    await scheduler.check(chat.project, fields, await owner(), current?.id)
    const presets = await presetNames(chat.project, [...(fields.presets as number[] | undefined) ?? [], ...current?.presets ?? []])
    const shown = (field: ChatScheduleField, value: unknown) => field === 'presets' && Array.isArray(value) ? value.map(p => presets.get(p) ?? p) : value
    const changes = (Object.entries(fields) as [ChatScheduleField, unknown][]).map(([field, to]) =>
        current ? {field, from: shown(field, current[field as keyof Schedule] ?? null), to: shown(field, to)} : {field, to: shown(field, to)})
    for (const m of chat.messages) if (current && m.schedule?.state === 'asked' && m.schedule.id === current.id) m.schedule.state = 'expired'
    const request: ChatScheduleRequest = {...current ? {id: current.id} : {}, title: String(fields.title ?? current?.title ?? ''), changes, body: fields, state: 'asked'}
    const said = add(chat, {from: 'claude', text: typeof why === 'string' ? why.trim() : '', images: [], schedule: request})
    useEventLog().note({level: 'info', kind: 'chat.asked', project: chat.project, message: `The chat asked to ${scheduleAsk(request)}`, details: {schedule: request.id ?? null, fields: Object.keys(fields)}})
    return said
}

/** The names of the presets `ids`, those that are still there. */
async function presetNames(project: string, ids: unknown[]): Promise<Map<unknown, string>> {
    if (!ids.length) return new Map()
    return new Map((await useStore().presets(project)).filter(p => ids.includes(p.id)).map(p => [p.id, p.name]))
}

/** What a schedule request asks, as a line: "make the schedule X", "change schedule 3 (X)". */
const scheduleAsk = (request: ChatScheduleRequest) => request.id === undefined
    ? `make the schedule "${request.title}"`
    : `change schedule ${request.id} ("${request.title}"): ${request.changes.map(c => `${CHAT_SCHEDULE_FIELDS[c.field]} to ${scheduleValue(c.to)}`).join(', ')}`

/** The chat's session asking to change one App setting (its `update_settings` tool), `{setting, value, why?}`: a request
 * in the chat, checked as the settings would check it, which saves nothing until the owner allows it. One it asked
 * before for the same setting, still unanswered, expires. */
export async function askSetting(id: string, body: unknown): Promise<ChatMessage> {
    const chat = chatOf(id)
    const {setting, value, why} = (body && typeof body === 'object' ? body : {}) as {setting?: unknown, value?: unknown, why?: unknown}
    if (typeof setting !== 'string' || !Object.hasOwn(CHAT_SETTINGS, setting))
        throw badRequest(`Send {setting, value}, setting one of ${Object.keys(CHAT_SETTINGS).join(', ')}; the rest are the owner's to change on App settings`)
    if (value === undefined) throw badRequest('Send the value to set as "value" (null for none)')
    const to = checkInput({[setting]: value}, {[setting]: known(SETTINGS_FIELDS[setting], 'the setting')}, true)[setting]
    const normal = setting === 'handle' && typeof to === 'string' ? to.toLowerCase() : to
    const from = (await useStore().settings())[setting as ChatSetting] ?? null
    for (const m of chat.messages) if (m.request?.state === 'asked' && m.request.setting === setting) m.request.state = 'expired'
    const said = add(chat, {from: 'claude', text: typeof why === 'string' ? why.trim() : '', images: [], request: {setting: setting as ChatSetting, from, to: normal, state: 'asked'}})
    useEventLog().note({level: 'info', kind: 'chat.asked', project: chat.project, message: `The chat asked to set ${CHAT_SETTINGS[setting as ChatSetting]} to ${settingValue(normal)}`, details: {setting, from, to: normal}})
    return said
}

/** The requests being answered right now, by chat and message: a second answer while the first is under way (a
 * double-click, another tab) is refused, rather than saving the schedule or sending the message twice (ORR-455). */
const answering = new Set<string>()

/** The owner's answer to a request (`allow`): allowed, the setting or the schedule is saved as asked; either way the
 * chat's session hears it. Only the owner's, from the page: the route refuses the chat's own session. */
export async function answer(id: string, message: number, allow: boolean, actor: Actor): Promise<ChatMessage> {
    const chat = chatOf(id)
    const asked = chat.messages.find(m => m.id === message && (m.request || m.schedule || m.send))
    const request = asked?.request ?? asked?.schedule ?? asked?.send
    if (!asked || !request) throw notFound(`No request ${message} in this chat`)
    if (request.state === 'asked' && Date.now() - Date.parse(asked.at) > ASK_FOR) {
        request.state = 'expired'
        changed(chat)
    }
    if (request.state !== 'asked') throw conflict(`That request is ${request.state} already${request.state === 'expired' ? ': ask the chat again' : ''}`)
    const key = `${chat.id}:${message}`
    if (answering.has(key)) throw conflict('That request is being answered already')
    answering.add(key)
    try {
        if (asked.send) await answerSend(chat, asked.send, allow, actor)
        else if (asked.schedule) await answerSchedule(chat, asked.schedule, allow, actor)
        else if (asked.request) await answerSetting(chat, asked.request, allow, actor)
    } finally {
        answering.delete(key)
    }
    return asked
}

/** The owner allowing or denying the chat's request for a schedule: allowed, it's made or changed as theirs, through
 * their chat. A request that no longer holds (its preset deleted since) fails as Schedules would, still asked. */
async function answerSchedule(chat: Chat, request: ChatScheduleRequest, allow: boolean, actor: Actor) {
    let made: Schedule | undefined
    if (allow) {
        const as: Actor = {...actor, via: 'chat'}
        made = request.id === undefined
            ? await useScheduler().create(chat.project, request.body, as)
            : await useScheduler().update(chat.project, request.id, request.body, as)
    }
    request.state = allow ? 'allowed' : 'denied'
    if (made) request.id = made.id
    changed(chat)
    useEventLog().note({level: 'info', kind: 'chat.answered', project: chat.project, message: `${actor.name} ${request.state} the chat's request to ${scheduleAsk(request)}`,
        details: {schedule: request.id ?? null, fields: Object.keys(request.body), allowed: allow}})
    await useStore().messageSession(chat.project, launchTarget(chat.id), made
        ? `(I allowed your request: schedule ${made.id} ("${made.title}") is saved${made.enabled ? '' : ', paused'}.)`
        : `(I denied your request to ${scheduleAsk(request)}: nothing changed.)`, actor)
}

/** The owner sending or not sending the message the chat asked to: sent, it goes as theirs, through their chat, to the
 * one session asked for, or to every session that fits now (who fits may have changed since it was asked). A session
 * that stopped listening since fails as messaging it would, still asked. Each session reached goes in `sent` at once,
 * so pressing Send again after one failed sends to the rest only, not to those that had it (ORR-455). */
async function answerSend(chat: Chat, request: ChatSendRequest, allow: boolean, actor: Actor) {
    if (allow) {
        const as: Actor = {...actor, via: 'chat'}
        const to = request.session
            ? [sessionNamed(request.session)]
            : recipients(request.projects, request.states)
        const sent = [...request.sent ?? []]
        try {
            for (const session of to) {
                if (sent.includes(session.name)) continue
                await useStore().messageSession(session.project, session.id, request.text, as)
                messaged(as, session.project, session.name)
                sent.push(session.name)
            }
        } catch (error) {
            // Still asked, with who has it already.
            if (sent.length) {
                request.sent = sent
                changed(chat)
            }
            throw error
        }
        request.sent = sent
    }
    request.state = allow ? 'allowed' : 'denied'
    changed(chat)
    useEventLog().note({level: 'info', kind: 'chat.answered', project: chat.project, message: `${actor.name} ${allow ? 'sent' : "didn't send"} the chat's message to ${(request.sent ?? request.to).join(', ') || 'no session'}`,
        details: {to: request.to, sent: request.sent ?? [], allowed: allow}})
    const sent = request.sent ?? []
    await useStore().messageSession(chat.project, launchTarget(chat.id), allow
        ? sent.length ? `(I sent your message to ${sent.join(', ')}.)` : '(I pressed Send, but no session fits any more, so it went to none.)'
        : `(I didn't send your message to ${request.to.join(', ')}: nothing went.)`, actor)
}

/** The owner allowing or denying the chat's request to change a setting: allowed, it's saved as asked. */
async function answerSetting(chat: Chat, request: NonNullable<ChatMessage['request']>, allow: boolean, actor: Actor) {
    const label = CHAT_SETTINGS[request.setting]
    if (allow) {
        await useStore().updateSettings({[request.setting]: request.to}, actor)
        useEventLog().note({level: 'info', kind: 'settings.changed', message: `${actor.name} changed the settings through their chat: ${request.setting}`,
            details: {by: actor.name, keys: [request.setting], via: 'chat', from: request.from, to: request.to}})
    }
    request.state = allow ? 'allowed' : 'denied'
    changed(chat)
    useEventLog().note({level: 'info', kind: 'chat.answered', project: chat.project, message: `${actor.name} ${request.state} the chat's request to set ${label} to ${settingValue(request.to)}`,
        details: {setting: request.setting, from: request.from, to: request.to, allowed: allow}})
    await useStore().messageSession(chat.project, launchTarget(chat.id), allow
        ? `(I allowed your request: ${label} is now ${settingValue(request.to)}, saved.)`
        : `(I denied your request to set ${label} to ${settingValue(request.to)}: nothing changed.)`, actor)
}

/** The owner choosing where the chat's issues land from now on. */
export function landChatIssues(id: string, issues: ChatIssues): Chat {
    const chat = chatOf(id)
    if (chat.issues !== issues) {
        chat.issues = issues
        changed(chat)
    }
    return chat
}

/** The chat's session answering (its `reply` tool). */
export function reply(id: string, text: unknown): ChatMessage {
    const chat = chatOf(id)
    const words = typeof text === 'string' ? text.trim() : ''
    if (!words) throw badRequest('Send the answer as {"text": "…"}')
    return add(chat, {from: 'claude', text: words, images: []})
}

/** The owner ending the chat: its session is stopped, and the chat goes. */
export function endChat(id: string) {
    const chat = chatOf(id)
    endLaunch(chat.project, id, true)
    chatEnded(id)
}

/** Why the chat's session can't start (a launcher too old to start one refused it), for the page to say instead of
 * waiting. It goes once the session connects. */
export function chatProblem(id: string, problem: string | null) {
    const chat = chats.get(id)
    if (!chat || (chat.problem ?? null) === problem) return
    if (problem) chat.problem = problem
    else delete chat.problem
    changed(chat)
}

/** The chat's launch has ended (stopped, or its session gone): the chat goes with it. */
export function chatEnded(id: string) {
    const chat = chats.get(id)
    if (!chat) return
    chats.delete(id)
    changed({...chat, ended: true})
}

/** Whether the request is a chat session's: its channel says so (`Orrery-Chat: yes`) on all it sends, or orrery knows
 * its session (`Orrery-Session`) as one. */
export function chatWrite(event: H3Event): boolean {
    const session = getHeader(event, 'orrery-session')?.trim()
    return getHeader(event, 'orrery-chat') === 'yes' || !!(session && chatSession(session))
}

/** Notes in the event log that the owner (or their chat) messaged a session. */
export function messaged(actor: Actor, project: string, session: string) {
    useEventLog().note({level: 'info', kind: 'session.messaged', project, message: `${actor.name}${actor.via ? ` (via ${actor.via})` : ''} messaged ${session}`})
}

/** An issue as the chat `chat` (its `Orrery-Launch`) asks to make it: on the roadmap as asked, but with nobody on it
 * and in the first status of the kind the owner picked for the chat (Todo, or Backlog), whatever status it asks for,
 * since a chat doesn't take work up or finish it. A proposal stays one, for the owner to decide as before. */
export function asChatIssue(body: unknown, chat?: string): unknown {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return body
    const {status: _status, plan: _plan, assignee: _assignee, ...rest} = body as Record<string, unknown>
    return rest.proposal === 'pending' ? rest : {...rest, status: (chat && chats.get(chat)?.issues) || 'todo'}
}

/** What the chat may change on an issue when the owner asks: what it says and where it sits, never its state of work. */
const CHAT_EDITS = ['title', 'notes', 'priority', 'labels', 'external', 'chunk', 'release', 'parent']

/** An edit to an issue from the chat, as it asks for it: refused (403) when it would change anything but `CHAT_EDITS`,
 * so a chat never starts, moves, assigns or finishes work, puts up a proposal or moves an issue to another project. */
export function asChatEdit(body: unknown): Record<string, unknown> {
    if (!isObject(body)) throw badRequest(`Send what to change: any of ${CHAT_EDITS.join(', ')}`)
    const refused = Object.keys(body).filter(key => !CHAT_EDITS.includes(key))
    if (refused.length) throw forbidden(`The owner's chat changes an issue's ${CHAT_EDITS.join(', ')}, not its ${refused.join(', ')}: it doesn't start, move or finish work`)
    return body
}
