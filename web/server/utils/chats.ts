import type {H3Event} from 'h3'
import type {Chat, ChatMessage} from '#shared/roadmap'

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
that. Every answer goes back with the reply tool, in Markdown: nothing else reaches the owner. Write an issue as a link
to its page, \`[<id>](/p/${project}/issues/<id>)\`, so the owner can open it.`

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

/** The owner writing in the chat, with the uploads they pasted (`images`, their ids): it goes to the chat's session
 * alone, as a message from the owner. */
export async function say(id: string, text: unknown, images: unknown, actor: {name: string, owner: boolean}): Promise<ChatMessage> {
    const chat = chatOf(id)
    const words = typeof text === 'string' ? text.trim() : ''
    const pasted = Array.isArray(images) ? images.filter((i): i is string => typeof i === 'string' && /^[0-9a-f]{24}$/.test(i)) : []
    if (!words && !pasted.length) throw badRequest('Send {text, images?}: what to say, and the ids of any uploads pasted with it')
    if (Array.isArray(images) && pasted.length !== images.length) throw badRequest('Send images as the ids of uploads (POST /api/uploads)')
    const note = [words, pasted.length ? `(${pasted.length === 1 ? 'An image' : `${pasted.length} images`} pasted with this: ${pasted.join(', ')}. Look with the image tool.)` : ''].filter(Boolean).join('\n\n')
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

/** An issue as a chat's session asks to make it: on the roadmap as asked, but with nobody on it and in the status
 * new issues start in, since it doesn't take work up. */
export function asChatIssue(body: unknown): unknown {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return body
    const {status: _status, assignee: _assignee, ...rest} = body as Record<string, unknown>
    return rest
}
