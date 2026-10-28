import type {H3Event} from 'h3'
import type {Chat, ChatMessage} from '#shared/roadmap'
import type {Actor} from '../store/schema'

// The owner's chats: a Claude session started for one alone (launches.ts `startChat`), which the owner talks to on the
// page instead of in a terminal. It answers questions about the project and makes issues and comments when asked;
// it works on nothing (middleware/chat.ts holds its writes to that, and it hears only the chat). The owner's words go
// to it as messages aimed at it; it answers with its channel's `reply` tool, kept here and streamed to the page
// (`chat` events). A chat is kept while its session runs, here only, and ends when the owner ends it.

/** What the chat's session on `project` is told it is, with every message. */
export const chatBrief = (project: string) => `This session is the owner's chat in Orrery: they type to you on its page and read what you send with the reply tool.
Answer their questions about this project: its code (read it), its roadmap and its docs (the issues, issue, chunks,
releases, docs and doc tools). When they ask for an issue or a comment, make it (create_issue, comment) and say which
id it got. You don't work on anything: don't change code, and don't start, move or finish issues; other sessions do
that. When the owner asks you to, in this chat, message other sessions (sessions lists them): message_sessions
nudges every idle one, message_session one by its name. Never on your own. Say in your reply what you sent and to
whom; for more than one session, draft it in a reply first and send it once the owner says go.
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

/** Starts a chat on the project: its session is on its way, and the chat is there to write in at once. */
export async function openChat(project: string): Promise<Chat> {
    const launch = await startChat(project, {presets: [], text: chatBrief(project)})
    const chat: Chat = {id: launch.id, project, started_at: new Date().toISOString(), messages: []}
    chats.set(chat.id, chat)
    changed(chat)
    return chat
}

/** The chats running now, newest first. */
export const listChats = (): Chat[] => [...chats.values()].reverse()

export function chatOf(id: string): Chat {
    const chat = chats.get(id)
    if (!chat) throw notFound(`No chat ${id}: it has ended, or Orrery restarted since`)
    return chat
}

function add(chat: Chat, message: Omit<ChatMessage, 'id' | 'at'>): ChatMessage {
    const said = {id: next++, at: new Date().toISOString(), ...message}
    chat.messages.push(said)
    changed(chat)
    return said
}

/** The page the owner is on as they write (`{path, title?}`), if it's one: a path on this Orrery, and its tab's title. */
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

/** Whether the request is a chat session's: its channel says so (`Orrery-Chat: yes`) on all it sends, or Orrery knows
 * its session (`Orrery-Session`) as one. */
export function chatWrite(event: H3Event): boolean {
    const session = getHeader(event, 'orrery-session')?.trim()
    return getHeader(event, 'orrery-chat') === 'yes' || !!(session && chatSession(session))
}

/** The owner, as their running chat (`Orrery-Launch`) speaking for them: what it sends other sessions goes as the
 * owner's, marked `via` it. */
export async function chatOwner(event: H3Event): Promise<Actor> {
    const launch = getHeader(event, 'orrery-launch')?.trim()
    if (!launch || !chats.has(launch)) throw forbidden("Only the owner's running chat messages sessions for them")
    return {name: (await useStore().ownerOf()).name, owner: true, via: 'chat'}
}

/** Notes in the event log that the owner (or their chat) messaged a session. */
export function messaged(actor: Actor, project: string, session: string) {
    useEventLog().note({level: 'info', kind: 'session.messaged', project, message: `${actor.name}${actor.via ? ` (via ${actor.via})` : ''} messaged ${session}`})
}

/** An issue as a chat's session asks to make it: on the roadmap as asked, but with nobody on it and in Todo (the first
 * status of that kind), whatever status it asks for, since the owner asked for it and a chat doesn't take work up or
 * finish it. A proposal stays one, for the owner to decide as before. */
export function asChatIssue(body: unknown): unknown {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return body
    const {status: _status, plan: _plan, assignee: _assignee, ...rest} = body as Record<string, unknown>
    return rest.proposal === 'pending' ? rest : {...rest, status: 'todo'}
}
