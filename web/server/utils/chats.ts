import type {H3Event} from 'h3'
import type {Chat, ChatChunkField, ChatChunkRequest, ChatIssues, ChatMessage, ChatMoveRequest, ChatReleaseField, ChatReleaseRequest, ChatScheduleRequest, ChatSendRequest, ChatSessionRequest, ChatSetting, Release, Schedule, Session, SessionState} from '#shared/roadmap'
import {CHAT_CHUNK_FIELDS, CHAT_ISSUES, CHAT_RELEASE_FIELDS, CHAT_SETTINGS, SESSION_STATES, scheduleValue, settingValue} from '#shared/roadmap'
import type {Actor} from '../store/schema'
import {CHUNK_FIELDS, SETTINGS_FIELDS} from '../store/schema'
import {checkInput, isObject} from './input'
import {known} from '#shared/known'
import {refusedFor} from './permission'
import {sessionHeader} from './actor'
import {scheduleAsk, scheduleRequest} from './schedule-requests'

// The owner's chats: a Claude session started for one alone (launches.ts `startChat`), which the owner talks to on the
// page instead of in a terminal. It answers questions about the project and makes issues and comments when asked;
// it works on nothing (middleware/chat.ts holds its writes to that, and it hears only the chat). The owner's words go
// to it as messages aimed at it; it answers with its channel's `reply` tool, kept here and streamed to the page
// (`chat` events). A chat is kept while its session runs, here only, and ends when the owner ends it.

/** What the chat's session on `project` is told it is, with every message. */
export const chatBrief = (project: string) => `This session is the owner's chat in orrery, on ${project}. Its tools and their asking
are in the server's instructions; what's left: a proposal waiting on the owner stays theirs to decide. Deleting a
schedule, removing a release or a chunk stays theirs too, on its page. Write an issue as a link to its page,
\`[<id>](/p/${project}/issues/<id>)\`. A page the owner has open on another project says so: there, "this" and "here"
aren't ${project}, and what you file still goes in ${project} unless they name the other, and say which (ORR-588).`

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

/** What the page hint adds when the page is on another project than the chat's: it isn't "here" (ORR-588). */
function elsewhere(path: string, project: string): string {
    const other = /^\/p\/([^/?#]+)/.exec(path)?.[1]
    return other && other !== project ? ` That page is on ${other}, not this chat's project, ${project}.` : ''
}

/** The owner writing in the chat, with the uploads they pasted (`images`, their ids) and the page they're on (`page`):
 * it goes to the chat's session alone, as a message from the owner, the page said at its end but not kept with it. A
 * run of messages held and sent together (`parts`, ORR-517) goes as one, joined by blank lines, and is kept as its parts. */
export async function say(id: string, text: unknown, images: unknown, actor: {name: string, owner: boolean}, page?: unknown, parts?: unknown): Promise<ChatMessage> {
    const chat = chatOf(id)
    const run = partsOf(parts)
    const words = run ? run.join('\n\n') : typeof text === 'string' ? text.trim() : ''
    const pasted = Array.isArray(images) ? images.filter((i): i is string => typeof i === 'string' && /^[0-9a-f]{24}$/.test(i)) : []
    if (!words && !pasted.length) throw badRequest('Send {text, images?}: what to say, and the ids of any uploads pasted with it')
    if (Array.isArray(images) && pasted.length !== images.length) throw badRequest('Send images as the ids of uploads (POST /api/uploads)')
    const on = pageOf(page)
    const note = [
        words,
        pasted.length ? `(${pasted.length === 1 ? 'An image' : `${pasted.length} images`} pasted with this: ${pasted.join(', ')}. Look with the image tool.)` : '',
        on ? `(The owner is on ${on.path}${on.title ? `: ${on.title}` : ''}.${elsewhere(on.path, chat.project)})` : '',
    ].filter(Boolean).join('\n\n')
    await useStore().messageSession(chat.project, launchTarget(id), note, actor)
    return add(chat, {from: 'owner', text: words, images: pasted, ...run && run.length > 1 ? {parts: run} : {}})
}

/** The parts of a run of messages, each trimmed, the empty ones left out; none when it isn't one. */
function partsOf(parts: unknown): string[] | undefined {
    if (parts === undefined || parts === null) return undefined
    if (!Array.isArray(parts) || parts.some(p => typeof p !== 'string')) throw badRequest('Send parts as a list of strings: the messages held and sent together')
    const run = (parts as string[]).map(p => p.trim()).filter(Boolean)
    return run.length ? run : undefined
}

/** How long a request to change a setting waits on the owner's answer. */
export const ASK_FOR = 30 * 60_000

/** The chat's session asking the owner for something in its chat: a message sent to sessions (`{message, why?}`,
 * `askSend`), a schedule made or changed (`{schedule, id?, why?}`, `askSchedule`), a release made or changed
 * (`{release, version?, why?}`, `askRelease`), a session started, stopped or given more time (`{session, why?}`,
 * `askSession`), a chunk made or changed (`{chunk, id?, why?}`, `askChunk`), issues moved or assigned (`{move, why?}`,
 * `askMove`), or else an App setting changed (`askSetting`). */
export async function ask(id: string, body: unknown): Promise<ChatMessage> {
    if (isObject(body) && 'session' in body) return await askSession(id, body)
    if (isObject(body) && 'message' in body) return await askSend(id, body)
    if (isObject(body) && 'release' in body) return await askRelease(id, body)
    if (isObject(body) && 'chunk' in body) return await askChunk(id, body)
    if (isObject(body) && 'move' in body) return await askMove(id, body)
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
    const request = await scheduleRequest(chat.project, fields, target, await owner(), "The owner's chat")
    for (const m of chat.messages) if (request.id !== undefined && m.schedule?.state === 'asked' && m.schedule.id === request.id) m.schedule.state = 'expired'
    const said = add(chat, {from: 'claude', text: typeof why === 'string' ? why.trim() : '', images: [], schedule: request})
    useEventLog().note({level: 'info', kind: 'chat.asked', project: chat.project, message: `The chat asked to ${scheduleAsk(request)}`, details: {schedule: request.id ?? null, fields: Object.keys(request.body)}})
    return said
}

/** The most issues one request moves. */
const MOVE_AT_MOST = 50

/** A proposal waiting on the owner (or on changes) isn't work yet: its status and assignee are theirs to decide. */
const undecided = (proposal: unknown) => proposal === 'pending' || proposal === 'changes'

/** The chat's session asking to move issues in its project to another status, or assign them (its `move_issues` tool):
 * `move` is `{ids, status?, assignee?}`, a status's id or a kind, and `owner`, an agent's name or null for the assignee.
 * A request in the chat showing each issue's from → to, checked as the owner's move would be, which moves nothing until
 * they allow it. Never a proposal waiting on the owner. One it asked before for any of the same issues, still unanswered,
 * expires. */
async function askMove(id: string, body: Record<string, unknown>): Promise<ChatMessage> {
    const chat = chatOf(id)
    const {move, why} = body as {move?: unknown, why?: unknown}
    const {ids, status, assignee} = (isObject(move) ? move : {}) as {ids?: unknown, status?: unknown, assignee?: unknown}
    if (!Array.isArray(ids) || !ids.length || ids.some(i => typeof i !== 'string' || !i.trim()) || (status === undefined && assignee === undefined)) {
        throw badRequest('Send {move: {ids, status?, assignee?}}: the issues, and the status to move them to, who to assign them to (null for nobody), or both')
    }
    if (ids.length > MOVE_AT_MOST) throw badRequest(`Ask to move at most ${MOVE_AT_MOST} issues at once`)
    if (assignee !== undefined && assignee !== null && typeof assignee !== 'string') throw badRequest('Send "assignee" as a name, "owner", or null for nobody')
    const store = useStore()
    const to = {
        ...status === undefined ? {} : {status: await store.resolveStatus(status as string)},
        ...assignee === undefined ? {} : {assignee: !assignee?.trim() ? null : assignee.trim().toLowerCase() === 'owner' ? (await store.ownerOf()).name : assignee.trim()},
    }
    const issues = await Promise.all([...new Set((ids as string[]).map(i => i.trim()))].map(i => store.issue(chat.project, i)))
    const waiting = issues.filter(i => undecided(i.proposal)).map(i => i.id)
    if (waiting.length) throw refusedFor('issues.edit', `${waiting.join(', ')} ${waiting.length === 1 ? 'is a proposal' : 'are proposals'} waiting on the owner: ${waiting.length === 1 ? 'its' : 'their'} status and assignee are theirs to decide, on ${waiting.length === 1 ? 'its' : 'their'} page`)
    const changes = issues.flatMap(i => [
        ...to.status !== undefined && to.status !== i.column ? [{issue: i.id, title: i.title, field: 'status' as const, from: i.column, to: to.status}] : [],
        ...to.assignee !== undefined && to.assignee !== (i.assignee ?? null) ? [{issue: i.id, title: i.title, field: 'assignee' as const, from: i.assignee ?? null, to: to.assignee}] : [],
    ])
    if (!changes.length) throw conflict(`${issues.length === 1 ? `${issues.map(i => i.id).join('')} is` : 'They are'} like that already: nothing would change`)
    const asking = issues.map(i => i.id)
    for (const m of chat.messages) if (m.move?.state === 'asked' && m.move.body.ids.some(i => asking.includes(i))) m.move.state = 'expired'
    const request: ChatMoveRequest = {changes, body: {ids: [...new Set(changes.map(c => c.issue))], ...to}, state: 'asked'}
    const said = add(chat, {from: 'claude', text: typeof why === 'string' ? why.trim() : '', images: [], move: request})
    useEventLog().note({level: 'info', kind: 'chat.asked', project: chat.project, message: `The chat asked to ${moveAsk(request)}`, details: {issues: request.body.ids, ...to}})
    return said
}

/** Where a move request puts its issues, as a phrase: "in done, assigned to claude". */
const moveTo = ({body: {status, assignee}}: ChatMoveRequest) => [
    status !== undefined ? `in ${status}` : '',
    assignee === undefined ? '' : assignee === null ? 'unassigned' : `assigned to ${assignee}`,
].filter(Boolean).join(', ')

/** What a move request asks, as a line: "put ORR-1, ORR-2 in done, assigned to claude". */
const moveAsk = (request: ChatMoveRequest) => `put ${request.body.ids.join(', ')} ${moveTo(request)}`

/** The chat's session asking to make a chunk in its project, or change chunk `id` there (its `create_chunk` and
 * `update_chunk` tools): `chunk` holds the fields (`CHAT_CHUNK_FIELDS`), checked as the chunk routes check them. A
 * request in the chat, which saves nothing until the owner allows it. One it asked before for the same chunk, still
 * unanswered, expires. */
async function askChunk(id: string, body: Record<string, unknown>): Promise<ChatMessage> {
    const chat = chatOf(id)
    const {chunk: fields, id: target, why} = body as {chunk?: unknown, id?: unknown, why?: unknown}
    if (!isObject(fields) || !Object.keys(fields).length) throw badRequest(`Send {chunk: {…}, id?}: the fields to set, any of ${Object.keys(CHAT_CHUNK_FIELDS).join(', ')}, and the chunk's id to change one`)
    const refused = Object.keys(fields).filter(key => !Object.hasOwn(CHAT_CHUNK_FIELDS, key))
    if (refused.length) throw forbidden(`The owner's chat sets a chunk's ${Object.keys(CHAT_CHUNK_FIELDS).join(', ')}, not its ${refused.join(', ')}`)
    if (target !== undefined && target !== null && typeof target !== 'string' && !Number.isInteger(target)) throw badRequest('Send "id" as the chunk to change, or leave it out to make one')
    const current = target === undefined || target === null ? undefined : await useStore().chunk(chat.project, String(target))
    checkInput(fields, CHUNK_FIELDS, !!current)
    const changes = (Object.entries(fields) as [ChatChunkField, unknown][]).map(([field, to]) =>
        current ? {field, from: current[field] ?? null, to} : {field, to})
    for (const m of chat.messages) if (current && m.chunk?.state === 'asked' && m.chunk.id === current.id) m.chunk.state = 'expired'
    const request: ChatChunkRequest = {...current ? {id: current.id} : {}, title: String(fields.title ?? current?.title ?? ''), changes, body: fields, state: 'asked'}
    const said = add(chat, {from: 'claude', text: typeof why === 'string' ? why.trim() : '', images: [], chunk: request})
    useEventLog().note({level: 'info', kind: 'chat.asked', project: chat.project, message: `The chat asked to ${chunkAsk(request)}`, details: {chunk: request.id ?? null, fields: Object.keys(fields)}})
    return said
}

/** What a chunk request asks, as a line: "make the chunk X", "change chunk 3 (X): Name to Y". */
const chunkAsk = (request: ChatChunkRequest) => request.id === undefined
    ? `make the chunk "${request.title}"`
    : `change chunk ${request.id} ("${request.title}"): ${request.changes.map(c => `${CHAT_CHUNK_FIELDS[c.field]} to ${settingValue(c.to)}`).join(', ')}`

/** The chat's session asking to make a release in its project, or change release `version` there (its `create_release`
 * and `update_release` tools): `release` holds the fields, as Releases takes them (`CHAT_RELEASE_FIELDS`). A request in
 * the chat, checked as Releases would check it, which saves nothing until the owner allows it. One it asked before for
 * the same release, still unanswered, expires. */
async function askRelease(id: string, body: Record<string, unknown>): Promise<ChatMessage> {
    const chat = chatOf(id)
    const {release: fields, version, why} = body as {release?: unknown, version?: unknown, why?: unknown}
    if (!isObject(fields) || !Object.keys(fields).length) throw badRequest(`Send {release: {…}, version?}: the fields to set, any of ${Object.keys(CHAT_RELEASE_FIELDS).join(', ')}, and the version of the release to change one`)
    const refused = Object.keys(fields).filter(key => !Object.hasOwn(CHAT_RELEASE_FIELDS, key))
    if (refused.length) throw forbidden(`The owner's chat sets a release's ${Object.keys(CHAT_RELEASE_FIELDS).join(', ')}, not its ${refused.join(', ')}`)
    if (version !== undefined && version !== null && typeof version !== 'string') throw badRequest('Send "version" as the version of the release to change, or leave it out to make one')
    const current = await useStore().checkRelease(chat.project, fields, typeof version === 'string' ? version : undefined)
    const shown = (field: ChatReleaseField, value: unknown) => field === 'position' && typeof value === 'number' ? place(value) : value
    const releases = current ? await useStore().listReleases(chat.project) : []
    const was = (field: ChatReleaseField) => field === 'position' ? releases.findIndex(r => r.version === current?.version) : current?.[field as keyof Release] ?? null
    const changes = (Object.entries(fields) as [ChatReleaseField, unknown][]).map(([field, to]) =>
        current ? {field, from: shown(field, was(field)), to: shown(field, to)} : {field, to: shown(field, to)})
    const named = current?.version ?? String(fields.version)
    for (const m of chat.messages) if (m.release?.state === 'asked' && m.release.version === named) m.release.state = 'expired'
    const request: ChatReleaseRequest = {version: named, change: !!current, changes, body: fields, state: 'asked'}
    const said = add(chat, {from: 'claude', text: typeof why === 'string' ? why.trim() : '', images: [], release: request})
    useEventLog().note({level: 'info', kind: 'chat.asked', project: chat.project, message: `The chat asked to ${releaseAsk(request)}`, details: {release: named, fields: Object.keys(fields)}})
    return said
}

/** A place among the releases, as a chat's request shows it: "the top", "2nd from the top". */
function place(index: number) {
    if (index <= 0) return 'the top'
    const n = Math.trunc(index) + 1
    const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({1: 'st', 2: 'nd', 3: 'rd'} as Record<number, string>)[n % 10] ?? 'th'
    return `${n}${suffix} from the top`
}

/** What a release request asks, as a line: "add the release 1.0.0", "change release 1.0.0: Branch to v1". */
const releaseAsk = (request: ChatReleaseRequest) => request.change
    ? `change release ${request.version}: ${request.changes.map(c => `${CHAT_RELEASE_FIELDS[c.field]} to ${scheduleValue(c.to)}`).join(', ')}`
    : `add the release ${request.version}`

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
    const asked = chat.messages.find(m => m.id === message && (m.request || m.schedule || m.send || m.release || m.session || m.chunk || m.move))
    const request = asked?.request ?? asked?.schedule ?? asked?.send ?? asked?.release ?? asked?.session ?? asked?.chunk ?? asked?.move
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
        if (asked.session) await answerSession(chat, asked.session, allow, actor)
        else if (asked.send) await answerSend(chat, asked.send, allow, actor)
        else if (asked.schedule) await answerSchedule(chat, asked.schedule, allow, actor)
        else if (asked.release) await answerRelease(chat, asked.release, allow, actor)
        else if (asked.chunk) await answerChunk(chat, asked.chunk, allow, actor)
        else if (asked.move) await answerMove(chat, asked.move, allow, actor)
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

/** The owner allowing or denying the chat's request for a release: allowed, it's made or changed as theirs, through
 * their chat. A request that no longer holds (the release made or removed since) fails as Releases would, still asked. */
async function answerRelease(chat: Chat, request: ChatReleaseRequest, allow: boolean, actor: Actor) {
    if (allow) {
        const as: Actor = {...actor, via: 'chat'}
        if (request.change) await useStore().updateRelease(chat.project, request.version, request.body, as)
        else await useStore().createRelease(chat.project, request.body, as)
    }
    request.state = allow ? 'allowed' : 'denied'
    changed(chat)
    useEventLog().note({level: 'info', kind: 'chat.answered', project: chat.project, message: `${actor.name} ${request.state} the chat's request to ${releaseAsk(request)}`,
        details: {release: request.version, fields: Object.keys(request.body), allowed: allow}})
    await useStore().messageSession(chat.project, launchTarget(chat.id), allow
        ? `(I allowed your request: release ${request.version} is ${request.change ? 'changed' : 'added'}.)`
        : `(I denied your request to ${releaseAsk(request)}: nothing changed.)`, actor)
}

/** The owner allowing or denying the chat's request to move or assign issues: allowed, each is changed as theirs, through
 * their chat, as their own move on the page would be (the session on one hears it the same way). One that became a
 * proposal waiting on them since, or can't be moved now, fails as their move would, still asked; those moved before it
 * stay in `moved`, so Allow again moves only the rest. */
async function answerMove(chat: Chat, request: ChatMoveRequest, allow: boolean, actor: Actor) {
    if (allow) {
        const as: Actor = {...actor, via: 'chat'}
        const {ids, ...to} = request.body
        const moved = [...request.moved ?? []]
        try {
            for (const id of ids) {
                if (moved.includes(id)) continue
                if (undecided((await useStore().issue(chat.project, id)).proposal)) throw refusedFor('issues.edit', `${id} is a proposal waiting on you now: decide it on its page`)
                await useStore().updateIssue(chat.project, id, to, as)
                moved.push(id)
            }
        } catch (error) {
            // Still asked, with those moved already.
            if (moved.length) {
                request.moved = moved
                changed(chat)
            }
            throw error
        }
        request.moved = moved
    }
    request.state = allow ? 'allowed' : 'denied'
    changed(chat)
    useEventLog().note({level: 'info', kind: 'chat.answered', project: chat.project, message: `${actor.name} ${request.state} the chat's request to ${moveAsk(request)}`,
        details: {issues: request.body.ids, allowed: allow}})
    await useStore().messageSession(chat.project, launchTarget(chat.id), allow
        ? `(I allowed your request: ${request.body.ids.join(', ')} ${request.body.ids.length === 1 ? 'is' : 'are'} now ${moveTo(request)}, saved.)`
        : `(I denied your request to ${moveAsk(request)}: nothing changed.)`, actor)
}

/** The owner allowing or denying the chat's request for a chunk: allowed, it's made or changed as theirs, through their
 * chat. A chunk removed since fails as its page would, still asked. */
async function answerChunk(chat: Chat, request: ChatChunkRequest, allow: boolean, actor: Actor) {
    let made: {id: string, title: string} | undefined
    if (allow) {
        made = request.id === undefined
            ? await useStore().createChunk(chat.project, request.body, {...actor, via: 'chat'})
            : await useStore().updateChunk(chat.project, request.id, request.body)
    }
    request.state = allow ? 'allowed' : 'denied'
    if (made) request.id = made.id
    changed(chat)
    useEventLog().note({level: 'info', kind: 'chat.answered', project: chat.project, message: `${actor.name} ${request.state} the chat's request to ${chunkAsk(request)}`,
        details: {chunk: request.id ?? null, fields: Object.keys(request.body), allowed: allow}})
    await useStore().messageSession(chat.project, launchTarget(chat.id), made
        ? `(I allowed your request: chunk ${made.id} ("${made.title}") is saved.)`
        : `(I denied your request to ${chunkAsk(request)}: nothing changed.)`, actor)
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

/** Any session listed, by its name or id (any case), that the chat may ask about: never a chat. */
function anySessionNamed(name: string): Session {
    const wanted = currentId(name.trim()).toLowerCase()
    const session = listSessions().find(s => (s.id.toLowerCase() === wanted || s.name.toLowerCase() === wanted) && !chatSession(s.id))
    if (!session) throw notFound(`No session ${name}: the sessions tool lists them`)
    return session
}

/** The chat's session asking to start a session, stop one, or give one more time (its `start_session`, `stop_session`
 * and `extend_session` tools, ORR-509): `session` is `{action: 'start', project?, issue?, statuses?, release?, presets?,
 * instructions?, hears?}`, as Start session takes them (on the chat's project unless it names another), or `{action:
 * 'stop' | 'extend', name, minutes?}` for a session by its name or id. A request in the chat, checked as the page would
 * check it, which does nothing until the owner allows it. One it asked before about the same session, still
 * unanswered, expires. */
async function askSession(id: string, body: Record<string, unknown>): Promise<ChatMessage> {
    const chat = chatOf(id)
    const {session: wanted, why} = body as {session?: unknown, why?: unknown}
    const action = isObject(wanted) ? wanted.action : undefined
    if (!isObject(wanted) || (action !== 'start' && action !== 'stop' && action !== 'extend')) {
        throw badRequest('Send {session: {action: "start", project?, issue?, statuses?, release?, presets?, instructions?, hears?}}, or {session: {action: "stop" or "extend", name, minutes?}}')
    }
    let request: ChatSessionRequest
    if (action === 'start') {
        const {action: _action, project: on, ...rest} = wanted
        const project = on === undefined || on === null ? chat.project : await useStore().projectId(String(on))
        const start = startInput(rest)
        const context = await contextFor(project, start.presets, start.instructions)
        request = {action, project, start, ...context?.presets.length ? {presets: context.presets} : {}, state: 'asked'}
    } else {
        const {name, minutes} = wanted
        if (typeof name !== 'string' || !name.trim()) throw badRequest('Send the session\'s "name" (or id): the sessions tool lists them')
        const session = anySessionNamed(name)
        if (action === 'stop' && !session.started && !session.reachable) throw conflict(`${session.name} has no orrery channel that can stop it: it's closed in its terminal`)
        if (action === 'extend' && !session.started) throw conflict(`${session.name} wasn't started by orrery, so it has no time to extend`)
        if (action === 'extend' && !session.started?.stops_at) throw conflict(`${session.name} runs until it's stopped: it has no time to extend`)
        const more = minutes === undefined || minutes === null ? 30 : minutes
        if (action === 'extend' && (!Number.isInteger(more) || Number(more) < 1 || Number(more) > 24 * 60)) throw badRequest(`"minutes" should be a whole number from 1 to 1440, not ${String(more)}`)
        for (const m of chat.messages) if (m.session?.state === 'asked' && m.session.session === session.id) m.session.state = 'expired'
        request = {action, project: session.project, session: session.id, name: session.name, ...action === 'extend' ? {minutes: Number(more)} : {}, state: 'asked'}
    }
    const said = add(chat, {from: 'claude', text: typeof why === 'string' ? why.trim() : '', images: [], session: request})
    useEventLog().note({level: 'info', kind: 'chat.asked', project: chat.project, message: `The chat asked to ${sessionAsk(request)}`, details: {action, project: request.project, ...request.name ? {session: request.name} : {}}})
    return said
}

/** What a session request asks, as a line: "start a session on hub, on HUB-12", "stop hub · Saga". */
function sessionAsk(request: ChatSessionRequest): string {
    if (request.action === 'stop') return `stop ${request.name}`
    if (request.action === 'extend') return `give ${request.name} ${request.minutes} more minutes`
    const start = request.start
    const on = start?.issue ? `, on ${start.issue}`
        : start?.statuses || start?.release ? `, working through ${start.statuses?.join(', ') ?? 'Todo and In progress'}${start.release ? ` in ${start.release}` : ''}` : ''
    return `start a session on ${request.project}${on}`
}

/** The owner allowing or denying the chat's request about a session: allowed, it's started, stopped or given more time
 * as theirs, through their chat, as the Sessions page would (the same limits, the same launcher). One that no longer
 * holds (no launcher now, the limit reached, the session gone) fails as the page would, still asked. */
async function answerSession(chat: Chat, request: ChatSessionRequest, allow: boolean, actor: Actor) {
    let done = ''
    if (allow) {
        const as: Actor = {...actor, via: 'chat'}
        if (request.action === 'start' && request.start) {
            const {presets, instructions, ...focus} = request.start
            const launch = await startLaunch(request.project, {...focus, context: await contextFor(request.project, presets, instructions), actor: as})
            request.launch = launch.id
            done = `a session is starting on ${request.project}`
        } else if (request.action === 'stop' && request.session) {
            stopSession(request.project, request.session)
            done = `${request.name} is stopping`
        } else if (request.action === 'extend' && request.session) {
            const launch = anySessionNamed(request.session).started?.launch
            if (!launch) throw conflict(`${request.name} wasn't started by orrery, so it has no time to extend`)
            extendLaunchBy(request.project, launch, request.minutes ?? 30)
            done = `${request.name} runs ${request.minutes} minutes longer`
        }
    }
    request.state = allow ? 'allowed' : 'denied'
    changed(chat)
    useEventLog().note({level: 'info', kind: 'chat.answered', project: chat.project, message: `${actor.name} ${request.state} the chat's request to ${sessionAsk(request)}`,
        details: {action: request.action, project: request.project, ...request.name ? {session: request.name} : {}, ...request.launch ? {launch: request.launch} : {}, allowed: allow}})
    await useStore().messageSession(chat.project, launchTarget(chat.id), allow
        ? `(I allowed your request: ${done}.)`
        : `(I denied your request to ${sessionAsk(request)}: nothing happened.)`, actor)
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

/** The owner clearing the chat's context (`/clear`): its launcher types `/clear` into the session, which keeps running
 * with a fresh context. It hears its brief again, as the launch's context, on the SessionStart after, so it stays the
 * chat. The chat marks the cut, and keeps what was said above it to read. */
export function clearChat(id: string): ChatMessage {
    const chat = chatOf(id)
    projectEvents.emit('launches', {type: 'clear', project: chat.project, id: chat.id})
    useEventLog().note({level: 'info', kind: 'chat.cleared', project: chat.project, message: "The owner cleared their chat's context"})
    return add(chat, {from: 'owner', text: '', images: [], cleared: true})
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
    const session = sessionHeader(event)
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
const CHAT_EDITS = ['title', 'notes', 'priority', 'labels', 'external', 'chunk', 'release', 'parent', 'depends_on']

/** An edit to an issue from the chat, as it asks for it: refused (403) when it would change anything but `CHAT_EDITS`,
 * so a chat never moves or assigns an issue on its own (only through a request the owner allows, `askMove`), puts up a
 * proposal or moves an issue to another project. */
export function asChatEdit(body: unknown): Record<string, unknown> {
    if (!isObject(body)) throw badRequest(`Send what to change: any of ${CHAT_EDITS.join(', ')}`)
    const refused = Object.keys(body).filter(key => !CHAT_EDITS.includes(key))
    if (refused.length) throw refusedFor('issues.edit', `The owner's chat changes an issue's ${CHAT_EDITS.join(', ')}, not its ${refused.join(', ')}: to move or assign one, it asks the owner (move_issues)`)
    return body
}
