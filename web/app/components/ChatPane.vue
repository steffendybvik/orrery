<script setup lang="ts">
import {CHAT_CHUNK_FIELDS, CHAT_RELEASE_FIELDS, CHAT_SCHEDULE_FIELDS, CHAT_SETTINGS, scheduleValue, settingValue} from '#shared/roadmap'
import {Menu, MenuButton, MenuItem, MenuItems} from '@headlessui/vue'
import type {ChatIssues, ChatMessage} from '#shared/roadmap'

// The owner's chat (useChat): a button in the corner of every page, and the pane it opens there, ready to type into.
// The first message starts a chat on the project in the header (the one you're on, or picked); once started, its
// session's state shows in the header and the conversation below, newest at the bottom. Enter holds the message under the
// box (Shift+Enter for a new line), and a run of them goes as one message once the owner has stopped typing for a moment
// (`HOLD_MS`, a draining bar showing it), so the chat answers the whole thought (ORR-517); ⌘/Ctrl-Enter or Send sends at
// once, and ✕ or Esc takes the last one back. A slash command goes at once, after what's held. An image pasted or
// dropped anywhere on the pane goes with the message. Closing the pane (×) ends the chat and stops its session; minimizing it
// (–, or Esc) hides it with the chat still running, and the corner button, marked while one runs, brings it back as it was.
// Esc closes the pane only before a chat starts, so a stray key doesn't end it. The pane can be made large (a phone's fills the screen either way). Beside
// Send, the owner picks where the issues it makes land, Todo or Backlog; the server holds the chat to it. A setting the
// chat asks to change shows from → to with Allow and Deny; only Allow saves it. So does a schedule it asks to make (each
// field it sets) or change (each from → to), a release it asks to add or change, a chunk it asks to make or change (ORR-510),
// a session it asks to start, stop or give more time (ChatSessionCard), and issues it asks to move or assign (each
// one's status or assignee, from → to, its id a link). A message it asks to send other sessions shows with who it goes to, and
// Send and Don't send; only Send sends it. Under each of Claude's replies, Copy takes its Markdown as written (on a
// wide screen it shows on hover or focus). A message that's just `/clear` clears the session's context instead of going
// to it: a divider marks the cut, and what was said above it stays, greyed. Any other slash command goes as words.
const {open, large, chat, session, project, failed, chats, lands, start, send, clear, land, fresh, answer, hide, close, resize, upload, show} = useChat()
const answering = ref<number | null>(null)
async function decide(message: number, allow: boolean) {
    answering.value = message
    await answer(message, allow)
    answering.value = null
}
const ANSWERED = {allowed: 'Allowed and saved', denied: 'Denied: nothing changed', expired: 'Expired: not answered in time, or asked again'}
const SENT = {allowed: (to: string[]) => to.length ? `Sent to ${to.join(', ')}` : 'Sent, but no session fit any more', denied: () => 'Not sent', expired: () => 'Expired: not answered in time'}
const {projects} = useRoadmaps()
const route = useRoute()
const {look} = useStatuses()
const statusName = (id: string | null) => id === null ? '(none)' : look(id).label
/** The issues a move request changes, each with its changes, in the order asked. */
const movedIssues = (changes: NonNullable<ChatMessage['move']>['changes']) =>
    [...new Set(changes.map(c => c.issue))].map(issue => ({issue, title: changes.find(c => c.issue === issue)?.title ?? '', changes: changes.filter(c => c.issue === issue)}))

const draft = ref('')
const images = ref<{id: string, url: string}[]>([])
const uploading = ref(0)
const sending = ref(false)
const list = ref<HTMLElement | null>(null)
const field = ref<HTMLTextAreaElement | null>(null)
const picker = ref<HTMLInputElement | null>(null)

/** The project the chat would be about: the one you're on, else the first. */
watch([() => route.params.project, projects], ([here]) => {
    if (!project.value || here) project.value = typeof here === 'string' && projects.value.some(p => p.id === here) ? here : project.value ?? projects.value[0]?.id ?? null
}, {immediate: true})
/** Where the issues the chat makes land: the running chat's, or the next one's. */
const landing = computed<ChatIssues>(() => chat.value && !chat.value.ended ? chat.value.issues : lands.value)
const LANDS: {value: ChatIssues, label: string}[] = [{value: 'todo', label: 'Todo'}, {value: 'backlog', label: 'Backlog'}]

const projectName = (id: string) => projects.value.find(p => p.id === id)?.name ?? id
const options = computed(() => projects.value.map(p => ({value: p.id, label: p.name})))
/** Which project it's about: the chat's, else the one the first message will start it on. */
const about = computed(() => chat.value && !chat.value.ended ? chat.value.project : project.value)
/** Nothing said yet: the pane greets you, with some things to ask. */
const empty = computed(() => !chat.value?.messages.length)

/** Things to ask, one about the issue or doc you're on. */
const examples = computed(() => {
    const here = typeof route.params.issue === 'string' ? `Summarize ${route.params.issue}`
        : typeof route.params.doc === 'string' ? 'Summarize this doc'
        : null
    return [...here ? [here] : [], "What's left in the next release?", 'How do schedules work?', ...here ? [] : ['File an issue for…']]
})
function ask(example: string) {
    draft.value = example.endsWith('…') ? example.slice(0, -1) : example
    nextTick(() => field.value?.focus())
}

const state = computed(() => {
    if (!chat.value) return ''
    if (chat.value.ended) return 'Ended'
    if (!session.value && chat.value.problem) return "Its session can't start"
    if (!session.value) return 'Starting the session…'
    return {working: 'Thinking…', waiting: 'Waiting on a prompt in its terminal', idle: 'Ready', starting: 'Starting the session…'}[session.value.state]
})
/** Whether the dots show: all the while its session works, whoever spoke last, so a reply partway through a turn doesn't
 * hide them (ORR-518); while it starts, only once the owner has said something it hasn't answered. */
const thinking = computed(() => {
    if (!chat.value || chat.value.ended || chat.value.problem) return false
    if (session.value?.state === 'working') return true
    const last = chat.value.messages.at(-1)
    return (!session.value || session.value.state === 'starting') && last?.from === 'owner' && !last.cleared
})

// The newest in sight as it comes, the dots too.
watch(() => [open.value, chat.value?.messages.length, thinking.value], () => nextTick(() => list.value?.scrollTo({top: list.value.scrollHeight})))
watch(open, now => now && nextTick(() => field.value?.focus()))

/** Where the session's context was last cleared: the messages before it, it no longer remembers. */
const cut = computed(() => chat.value?.messages.findLastIndex(m => m.cleared) ?? -1)

/** How long after the owner's last keystroke a run of held messages goes. */
const HOLD_MS = 2000
/** The owner's messages held under the box, to go together. */
const held = ref<{key: number, text: string, images: {id: string, url: string}[]}[]>([])
let heldKey = 0
let holdTimer: ReturnType<typeof setTimeout> | undefined
/** Counts each restart of the wait, so the draining bar starts over. */
const holds = ref(0)

/** Starts the wait over, from now: what's held goes once it runs out. */
function restartHold() {
    clearTimeout(holdTimer)
    if (!held.value.length) return
    holds.value++
    holdTimer = setTimeout(() => void flush(), HOLD_MS)
}

/** Sends what's held as one message, starting the chat first when there's none yet; what's held stays if it can't go. */
async function flush() {
    clearTimeout(holdTimer)
    if (!held.value.length || sending.value || uploading.value) return
    const run = held.value
    sending.value = true
    if (chat.value?.ended) fresh()
    const texts = run.map(m => m.text).filter(Boolean)
    const ids = run.flatMap(m => m.images.map(i => i.id))
    if ((chat.value || await start()) && await send(texts.length > 1 ? texts : texts[0] ?? '', ids)) {
        held.value = held.value.filter(m => !run.includes(m))
    }
    sending.value = false
    // Held while that went: their wait starts now.
    restartHold()
}

/** Takes a held message back before it goes: into the box when the box is empty. */
function takeBack(key: number) {
    const message = held.value.find(m => m.key === key)
    if (!message) return
    held.value = held.value.filter(m => m !== message)
    if (!draft.value.trim() && !images.value.length) {
        draft.value = message.text
        images.value = message.images
    }
    restartHold()
    field.value?.focus()
}

/** Holds what's in the composer to go with the rest (`now`: sends it all at once). A slash command goes at once, after
 * what's held; `/clear` clears the running chat's context instead, and with none running there's nothing to clear. */
async function submit(now = false) {
    const text = draft.value.trim()
    if (uploading.value) return
    if (/^\/[a-z][\w-]*(\s|$)/i.test(text) && !images.value.length) {
        await flush()
        if (sending.value) return
        sending.value = true
        if (text === '/clear') {
            if (!chat.value || chat.value.ended || await clear()) draft.value = ''
        } else {
            if (chat.value?.ended) fresh()
            if ((chat.value || await start()) && await send(text, [])) draft.value = ''
        }
        sending.value = false
        return
    }
    if (text || images.value.length) {
        held.value.push({key: ++heldKey, text, images: images.value})
        draft.value = ''
        images.value = []
    }
    if (now) await flush()
    else restartHold()
}

function onKey(event: KeyboardEvent) {
    if (event.isComposing) return
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        void submit(true)
    } else if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        void submit()
    } else if (event.key === 'Escape' && held.value.length) {
        // Takes the last one back, rather than minimizing the pane.
        event.preventDefault()
        event.stopPropagation()
        const last = held.value.at(-1)
        if (last) takeBack(last.key)
    }
}
// Typing the next part puts the wait off.
watch(draft, () => restartHold())
onBeforeUnmount(() => clearTimeout(holdTimer))

async function attach(files: File[]) {
    for (const file of files.filter(f => f.type.startsWith('image/'))) {
        uploading.value++
        try {
            const made = await upload(file)
            images.value.push({id: made.id, url: made.url})
        } catch (error) {
            failed.value = errorMessage(error, 'add')
        } finally {
            uploading.value--
        }
    }
    // Back to typing the message it goes with.
    field.value?.focus()
}
const {over, on: drop} = useImageDrop(attach)
</script>

<template>
  <button
      v-if="!open"
      type="button"
      class="fixed right-4 bottom-4 z-40 inline-flex h-8 items-center gap-1.5 rounded-lg bg-panel px-3.5 text-[13px] text-fg shadow-md ring-1 ring-line transition hover:tint"
      :title="chats.length ? 'Back to your chat: it is still running' : 'Chat about a project: an agent answers and makes issues'"
      @click="show()"
  >
    <svg
        class="size-4 text-accent-500"
        :class="{'animate-pulse motion-reduce:animate-none': chats.length}"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
    ><path d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" /></svg>
    Agent
    <span v-if="chats.length" class="sr-only">(a chat is running)</span>
  </button>

  <section
      v-else
      class="fixed right-4 bottom-4 z-40 flex w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl"
      :class="large ? 'h-[calc(100dvh-2rem)] sm:w-[min(56rem,calc(100vw-2rem))]' : 'h-[min(40rem,calc(100dvh-2rem))] sm:w-[min(28rem,calc(100vw-2rem))]'"
      aria-label="Chat"
      v-on="drop"
      @keydown.esc="!chat || chat.ended ? close() : hide()"
  >
    <ImageDropOverlay v-if="over" />
    <header class="flex items-center gap-1 border-b border-line py-2.5 pr-2.5 pl-4">
      <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-fg">
          <span>Chat</span>
          <template v-if="about">
            <span class="text-faint">·</span>
            <PropertyPicker v-if="(!chat || chat.ended) && options.length > 1" :model-value="project ?? ''" :options="options" label="Project" field small @update:model-value="project = String($event)">
              <span class="truncate">{{ projectName(about) }}</span>
            </PropertyPicker>
            <span v-else class="truncate">{{ projectName(about) }}</span>
          </template>
        </div>
        <span v-if="state" class="flex items-center gap-1.5 text-xs text-faint">
          <SessionDot v-if="session" :session="session" />{{ state }}
        </span>
      </div>
      <UiButton variant="ghost" size="xs" square class="max-sm:hidden" :aria-label="large ? 'Make the chat smaller' : 'Make the chat larger'" :title="large ? 'Smaller' : 'Larger'" @click="resize">
        <svg v-if="large" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 9V4.5M9 9H4.5M9 9 3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5 5.25 5.25" /></svg>
        <svg v-else class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" /></svg>
      </UiButton>
      <UiButton v-if="chat && !chat.ended" variant="ghost" size="xs" square aria-label="Minimize the chat, leaving it running" title="Minimize" @click="hide">
        <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14" /></svg>
      </UiButton>
      <UiButton variant="ghost" size="xs" square :aria-label="chat && !chat.ended ? 'End the chat and close it' : 'Close the chat'" :title="chat && !chat.ended ? 'End chat' : 'Close'" @click="close">
        <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 18 18 6M6 6l12 12" /></svg>
      </UiButton>
    </header>

    <div v-if="empty" class="flex flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-6">
      <div class="flex w-full max-w-sm flex-col items-center gap-2 text-center">
        <h2 class="text-base font-semibold text-fg">{{ about ? `Ask about ${projectName(about)}` : 'Ask away' }}</h2>
        <p class="text-[13px] text-muted">Code, roadmap and docs. I can file issues and comments for you.</p>
        <div class="mt-3 flex flex-wrap justify-center gap-1.5">
          <button
              v-for="example in examples"
              :key="example"
              type="button"
              class="rounded-full px-3 py-1.5 text-xs text-muted ring-1 ring-line transition hover:bg-hover hover:text-fg"
              @click="ask(example)"
          >
            {{ example }}
          </button>
        </div>
      </div>
    </div>

    <ol v-else ref="list" class="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4 text-[13px]">
      <template v-for="(m, i) in chat!.messages" :key="m.id">
      <li v-if="m.cleared" class="flex items-center gap-3 py-1 text-xs text-faint" role="separator" aria-label="Context cleared">
        <span class="h-px flex-1 bg-line" />Context cleared<span class="h-px flex-1 bg-line" />
      </li>
      <li v-else class="flex flex-col gap-1.5" :class="[m.from === 'owner' ? 'items-end' : 'items-start', i < cut && 'opacity-60']">
        <div v-if="m.images.length" class="flex flex-wrap justify-end gap-1.5">
          <img v-for="id in m.images" :key="id" :src="`/api/uploads/${id}`" alt="" class="max-h-32 rounded-lg ring-1 ring-line">
        </div>
        <template v-if="m.from === 'owner' && m.text">
          <div v-for="(part, p) in m.parts ?? [m.text]" :key="p" class="max-w-[85%] rounded-2xl rounded-br-md bg-accent-500/15 px-3 py-2 whitespace-pre-wrap text-fg">{{ part }}</div>
        </template>
        <div v-else-if="m.text" class="group flex max-w-[92%] flex-col items-start gap-1">
          <div class="rounded-2xl rounded-bl-md bg-well px-3.5 py-2.5 ring-1 ring-line/60">
            <MarkdownView :source="m.text" class="text-[13px]" />
          </div>
          <CopyButton :text="m.text" name="this reply" class="transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100" />
        </div>
        <ChatSessionCard v-if="m.session" :request="m.session" :busy="answering === m.id" :ended="!!chat!.ended" @decide="allow => decide(m.id, allow)" />
        <div v-if="m.request" class="flex w-full flex-col gap-2 rounded-xl bg-well p-3 ring-1 ring-line" role="group" :aria-label="`Change ${CHAT_SETTINGS[m.request.setting]}`">
          <span class="text-xs text-faint">Asks to change a setting</span>
          <span class="text-fg"><span class="font-medium">{{ CHAT_SETTINGS[m.request.setting] }}</span>:
            <span class="text-muted line-through decoration-faint">{{ settingValue(m.request.from) }}</span> → <span class="break-all">{{ settingValue(m.request.to) }}</span></span>
          <div v-if="m.request.state === 'asked' && !chat!.ended" class="flex gap-2">
            <UiButton variant="primary" size="sm" :disabled="answering === m.id" @click="decide(m.id, true)">Allow</UiButton>
            <UiButton size="sm" :disabled="answering === m.id" @click="decide(m.id, false)">Deny</UiButton>
          </div>
          <span v-else class="text-xs" :class="m.request.state === 'allowed' ? 'text-emerald-600 dark:text-emerald-400' : 'text-faint'">{{ m.request.state === 'asked' ? 'Not answered' : ANSWERED[m.request.state] }}</span>
        </div>
        <div v-if="m.send" class="flex w-full flex-col gap-2 rounded-xl bg-well p-3 ring-1 ring-line" role="group" :aria-label="`Send a message to ${m.send.to.join(', ')}`">
          <span class="text-xs text-faint">Asks to send a message as you to {{ m.send.session ? m.send.to[0] : `${m.send.states?.join(' or ') ?? 'idle'} sessions${m.send.projects?.length ? ` on ${m.send.projects.join(', ')}` : ''} (now ${m.send.to.join(', ')})` }}</span>
          <p class="max-h-60 overflow-y-auto break-words whitespace-pre-wrap text-[13px] text-fg">{{ m.send.text }}</p>
          <div v-if="m.send.state === 'asked' && !chat!.ended" class="flex gap-2">
            <UiButton variant="primary" size="sm" :disabled="answering === m.id" @click="decide(m.id, true)">Send</UiButton>
            <UiButton size="sm" :disabled="answering === m.id" @click="decide(m.id, false)">Don't send</UiButton>
          </div>
          <span v-else class="text-xs" :class="m.send.state === 'allowed' ? 'text-emerald-600 dark:text-emerald-400' : 'text-faint'">{{ m.send.state === 'asked' ? 'Not answered' : SENT[m.send.state](m.send.sent ?? []) }}</span>
        </div>
        <div
v-if="m.schedule" class="flex w-full flex-col gap-2 rounded-xl bg-well p-3 ring-1 ring-line" role="group"
             :aria-label="m.schedule.changes.some(c => c.from !== undefined) ? `Change schedule ${m.schedule.title}` : `Make schedule ${m.schedule.title}`">
          <span class="text-xs text-faint">{{ m.schedule.changes.some(c => c.from !== undefined) ? `Asks to change schedule ${m.schedule.id}` : 'Asks to make a schedule' }}</span>
          <span class="font-medium text-fg">{{ m.schedule.title }}</span>
          <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
            <template v-for="c in m.schedule.changes.filter(c => c.field !== 'title' || c.from !== undefined)" :key="c.field">
              <dt class="text-muted">{{ CHAT_SCHEDULE_FIELDS[c.field] }}</dt>
              <dd class="min-w-0 break-words whitespace-pre-wrap text-fg">
                <template v-if="c.from !== undefined"><span class="text-muted line-through decoration-faint">{{ scheduleValue(c.from) }}</span> → </template>{{ scheduleValue(c.to) }}
              </dd>
            </template>
          </dl>
          <div v-if="m.schedule.state === 'asked' && !chat!.ended" class="flex gap-2">
            <UiButton variant="primary" size="sm" :disabled="answering === m.id" @click="decide(m.id, true)">Allow</UiButton>
            <UiButton size="sm" :disabled="answering === m.id" @click="decide(m.id, false)">Deny</UiButton>
          </div>
          <span v-else class="text-xs" :class="m.schedule.state === 'allowed' ? 'text-emerald-600 dark:text-emerald-400' : 'text-faint'">{{ m.schedule.state === 'asked' ? 'Not answered' : ANSWERED[m.schedule.state] }}</span>
        </div>
        <div v-if="m.release" class="flex w-full flex-col gap-2 rounded-xl bg-well p-3 ring-1 ring-line" role="group" :aria-label="m.release.change ? `Change release ${m.release.version}` : `Add release ${m.release.version}`">
          <span class="text-xs text-faint">{{ m.release.change ? 'Asks to change a release' : 'Asks to add a release' }}</span>
          <span class="font-medium text-fg">{{ m.release.version }}</span>
          <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
            <template v-for="c in m.release.changes.filter(c => c.field !== 'version')" :key="c.field">
              <dt class="text-muted">{{ CHAT_RELEASE_FIELDS[c.field] }}</dt>
              <dd class="min-w-0 break-words whitespace-pre-wrap text-fg">
                <template v-if="c.from !== undefined"><span class="text-muted line-through decoration-faint">{{ scheduleValue(c.from) }}</span> → </template>{{ scheduleValue(c.to) }}
              </dd>
            </template>
          </dl>
          <div v-if="m.release.state === 'asked' && !chat!.ended" class="flex gap-2">
            <UiButton variant="primary" size="sm" :disabled="answering === m.id" @click="decide(m.id, true)">Allow</UiButton>
            <UiButton size="sm" :disabled="answering === m.id" @click="decide(m.id, false)">Deny</UiButton>
          </div>
          <span v-else class="text-xs" :class="m.release.state === 'allowed' ? 'text-emerald-600 dark:text-emerald-400' : 'text-faint'">{{ m.release.state === 'asked' ? 'Not answered' : ANSWERED[m.release.state] }}</span>
        </div>
        <div
v-if="m.chunk" class="flex w-full flex-col gap-2 rounded-xl bg-well p-3 ring-1 ring-line" role="group"
             :aria-label="m.chunk.changes.some(c => c.from !== undefined) ? `Change chunk ${m.chunk.title}` : `Make chunk ${m.chunk.title}`">
          <span class="text-xs text-faint">{{ m.chunk.changes.some(c => c.from !== undefined) ? `Asks to change chunk ${m.chunk.id}` : 'Asks to make a chunk' }}</span>
          <span class="font-medium text-fg">{{ m.chunk.title }}</span>
          <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
            <template v-for="c in m.chunk.changes.filter(c => c.field !== 'title' || c.from !== undefined)" :key="c.field">
              <dt class="text-muted">{{ CHAT_CHUNK_FIELDS[c.field] }}</dt>
              <dd class="min-w-0 break-words whitespace-pre-wrap text-fg">
                <template v-if="c.from !== undefined"><span class="text-muted line-through decoration-faint">{{ settingValue(c.from) }}</span> → </template>{{ settingValue(c.to) }}
              </dd>
            </template>
          </dl>
          <div v-if="m.chunk.state === 'asked' && !chat!.ended" class="flex gap-2">
            <UiButton variant="primary" size="sm" :disabled="answering === m.id" @click="decide(m.id, true)">Allow</UiButton>
            <UiButton size="sm" :disabled="answering === m.id" @click="decide(m.id, false)">Deny</UiButton>
          </div>
          <span v-else class="text-xs" :class="m.chunk.state === 'allowed' ? 'text-emerald-600 dark:text-emerald-400' : 'text-faint'">{{ m.chunk.state === 'asked' ? 'Not answered' : ANSWERED[m.chunk.state] }}</span>
        </div>
        <div v-if="m.move" class="flex w-full flex-col gap-2 rounded-xl bg-well p-3 ring-1 ring-line" role="group" :aria-label="`Move ${m.move.body.ids.join(', ')}`">
          <span class="text-xs text-faint">Asks to move {{ m.move.body.ids.length === 1 ? 'an issue' : `${m.move.body.ids.length} issues` }}, as you</span>
          <ul class="flex flex-col gap-1.5 text-[13px]">
            <li v-for="one in movedIssues(m.move.changes)" :key="one.issue" class="flex min-w-0 flex-col">
              <span class="min-w-0 truncate"><NuxtLink :to="`/p/${chat!.project}/issues/${one.issue}`" class="font-medium text-accent-600 hover:underline dark:text-accent-400">{{ one.issue }}</NuxtLink> <span class="text-fg">{{ one.title }}</span></span>
              <span v-for="c in one.changes" :key="c.field" class="flex flex-wrap items-center gap-1 text-muted">
                <template v-if="c.field === 'status'">
                  <StatusIcon v-if="c.from" :column="c.from" :size="12" /><span class="line-through decoration-faint">{{ statusName(c.from) }}</span> →
                  <StatusIcon v-if="c.to" :column="c.to" :size="12" /><span class="text-fg">{{ statusName(c.to) }}</span>
                </template>
                <template v-else>
                  Assignee <span class="line-through decoration-faint">{{ c.from ?? '(nobody)' }}</span> → <span class="text-fg">{{ c.to ?? '(nobody)' }}</span>
                </template>
              </span>
            </li>
          </ul>
          <span v-if="m.move.state === 'asked' && m.move.moved?.length" class="text-xs text-faint">Moved so far: {{ m.move.moved.join(', ') }}</span>
          <div v-if="m.move.state === 'asked' && !chat!.ended" class="flex gap-2">
            <UiButton variant="primary" size="sm" :disabled="answering === m.id" @click="decide(m.id, true)">Allow</UiButton>
            <UiButton size="sm" :disabled="answering === m.id" @click="decide(m.id, false)">Deny</UiButton>
          </div>
          <span v-else class="text-xs" :class="m.move.state === 'allowed' ? 'text-emerald-600 dark:text-emerald-400' : 'text-faint'">{{ m.move.state === 'asked' ? 'Not answered' : ANSWERED[m.move.state] }}</span>
        </div>
      </li>
      </template>
      <li v-if="thinking" class="flex items-center gap-1 px-1 py-2" aria-live="polite" aria-label="Thinking…">
        <span v-for="i in 3" :key="i" class="size-1.5 animate-dot rounded-full bg-faint" :style="{animationDelay: `${(i - 1) * 0.15}s`}" />
      </li>
      <li v-if="chat!.ended" class="flex items-center gap-2 text-xs text-faint">
        This chat has ended.
        <button type="button" class="text-accent-600 hover:underline dark:text-accent-400" @click="fresh">Start another</button>
      </li>
    </ol>

    <form v-if="!chat?.ended || !chat.messages.length" class="flex flex-col gap-2 p-3" @submit.prevent="submit(true)">
      <p v-if="failed" class="px-1 text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>
      <!-- What's held to go together: each as its own bubble, and a bar that drains until they go, starting over as you type. -->
      <div v-if="held.length" class="flex flex-col items-end gap-1.5" role="group" aria-label="Held to send together">
        <div v-for="m in held" :key="m.key" class="group relative flex max-w-[85%] flex-col items-end gap-1">
          <div v-if="m.images.length" class="flex flex-wrap justify-end gap-1.5">
            <img v-for="image in m.images" :key="image.id" :src="image.url" alt="" class="max-h-20 rounded-lg opacity-70 ring-1 ring-line">
          </div>
          <div v-if="m.text" class="rounded-2xl rounded-br-md border border-dashed border-accent-500/40 bg-accent-500/10 px-3 py-2 text-[13px] whitespace-pre-wrap text-muted">{{ m.text }}</div>
          <button type="button" class="absolute -top-1.5 -left-1.5 grid size-4 place-items-center rounded-full bg-fg text-[10px] text-panel" :aria-label="`Take back: ${m.text || 'the image'}`" title="Take it back (Esc)" @click="takeBack(m.key)">×</button>
        </div>
        <div class="flex w-full items-center gap-2 text-[11px] text-faint" aria-live="polite">
          <span class="relative h-0.5 flex-1 overflow-hidden rounded-full bg-line">
            <span v-if="!sending" :key="holds" class="absolute inset-0 animate-drain origin-right rounded-full bg-accent-500 motion-reduce:hidden" :style="{animationDuration: `${HOLD_MS}ms`}" />
          </span>
          <span>{{ sending ? 'Sending…' : `Sends ${HOLD_MS / 1000} s after you stop typing` }}</span>
          <button type="button" class="text-accent-600 hover:underline disabled:opacity-50 dark:text-accent-400" :disabled="sending" @click="flush()">Send now</button>
        </div>
      </div>
      <div class="flex flex-col gap-2 rounded-2xl bg-well p-2 ring-1 ring-line transition focus-within:ring-accent-500/50">
        <div v-if="images.length || uploading" class="flex flex-wrap gap-1.5 px-1 pt-1">
          <div v-for="(image, i) in images" :key="image.id" class="relative">
            <img :src="image.url" alt="" class="size-14 rounded-lg object-cover ring-1 ring-line">
            <button type="button" class="absolute -top-1.5 -right-1.5 grid size-4 place-items-center rounded-full bg-fg text-[10px] text-panel" :aria-label="`Remove image ${i + 1}`" @click="images.splice(i, 1)">×</button>
          </div>
          <span v-if="uploading" class="grid size-14 place-items-center rounded-lg text-[11px] text-faint ring-1 ring-line">Adding…</span>
        </div>
        <textarea
            ref="field"
            v-model="draft"
            rows="1"
            aria-label="Message"
            placeholder="Ask anything…"
            title="Enter holds it to go with the next (it sends once you stop typing); ⌘-Enter sends now; Shift-Enter for a new line"
            class="field-sizing-content max-h-40 min-h-9 resize-none bg-transparent px-2 py-1.5 text-[13px] text-fg placeholder:text-faint focus:outline-none"
            @keydown="onKey"
        />
        <div class="flex items-center gap-1">
          <UiButton variant="ghost" size="xs" square aria-label="Add an image" title="Add an image (or paste or drop one)" @click="picker?.click()">
            <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A1.5 1.5 0 0 0 21.75 19.5V4.5A1.5 1.5 0 0 0 20.25 3H3.75A1.5 1.5 0 0 0 2.25 4.5v15A1.5 1.5 0 0 0 3.75 21Zm10.5-11.25h.008v.008h-.008V9.75Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" /></svg>
          </UiButton>
          <input ref="picker" type="file" accept="image/*" multiple class="hidden" @change="attach([...($event.target as HTMLInputElement).files ?? []]); ($event.target as HTMLInputElement).value = ''">
          <Menu as="div" class="relative ml-auto">
            <MenuButton as="template">
              <UiButton variant="ghost" size="xs" title="Where the issues this chat makes land">
                New issues → {{ landing === 'todo' ? 'Todo' : 'Backlog' }}
                <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg>
              </UiButton>
            </MenuButton>
            <MenuItems class="menu absolute right-0 bottom-full z-40 mb-1.5 w-44">
              <MenuItem v-for="where in LANDS" :key="where.value" v-slot="{active}" as="template">
                <UiMenuItem :active="landing === where.value" :lit="active" @click="land(where.value)">New issues → {{ where.label }}</UiMenuItem>
              </MenuItem>
            </MenuItems>
          </Menu>
          <UiButton type="submit" variant="primary" size="xs" square class="rounded-full" aria-label="Send" title="Send now (⌘↵)" :disabled="sending || !!uploading || !about || !draft.trim() && !images.length && !held.length">
            <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5m0 0-6 6m6-6 6 6" /></svg>
          </UiButton>
        </div>
      </div>
    </form>
  </section>
</template>

