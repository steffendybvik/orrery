<script setup lang="ts">
import {CHAT_MILESTONE_FIELDS, CHAT_RELEASE_FIELDS, CHAT_SETTINGS, nameBesideProject, scheduleValue, settingValue} from '#shared/roadmap'
import {Menu, MenuButton, MenuItem, MenuItems} from '@headlessui/vue'
import type {Chat, ChatIssues, ChatMessage} from '#shared/roadmap'

// The owner's chat (useChat): a button in the corner of every page, and the pane it opens there, ready to type into.
// The first message starts a chat on the project in the header (the one you're on, or picked); once started, its
// session's name shows in the header and the conversation below, newest at the bottom. Enter sends (Shift+Enter for a new
// line), but a run of quick messages goes as one once the owner has stopped typing for a moment (`HOLD_MS`), so the chat
// answers the whole thought (ORR-517). What's held shows at once as sent, with the thinking spinner, as one turn (ORR-535);
// only what couldn't go says so (Not sent, Retry). ⌘/Ctrl-Enter or Send sends at once, and Esc in an empty box takes the
// last one back. A slash command goes at once, after what's held. The chat ending, or closing the pane before one has
// started, puts what's held back in the box, so nothing starts a chat on its own after it (ORR-523). An image pasted or
// dropped anywhere on the pane goes with the message. The pane is open or closed: closing it (× or Esc) only hides it,
// with the chat still running (ORR-878, ORR-883), and the corner button brings it back as it was. Whether the chat is
// live isn't shown, only a session that can't start. Only a row's × in the list ends a chat. The pane can be made large; a phone's fills the screen either way, as it has no Larger button. Beside
// Send, the owner picks where the issues it makes land, Todo or Backlog; the server holds the chat to it. A setting the
// chat asks to change shows from → to with Allow and Deny; only Allow saves it. So does a schedule it asks to make (each
// field it sets) or change (each from → to), a release it asks to add or change, a milestone it asks to make or change (ORR-510),
// a doc it asks to make or change (ChatDocCard, ORR-661), an issue it offers to file (ChatIssueCard, ORR-711), a session it asks to start, stop or give more time (ChatSessionCard), and issues it asks to move or assign (each
// one's status or assignee, from → to, its id a link). A message it asks to send other sessions shows with who it goes to, and
// Send and Don't send; only Send sends it. Under each of Claude's replies, Copy takes its Markdown as written (on a
// wide screen it shows on hover or focus). A message that's just `/clear` clears the session's context instead of going
// to it: a divider marks the cut, and what was said above it stays, greyed. Any other slash command goes as words.
// The pane's project follows the page you're on; picking one by hand pins it (the pin beside the picker), so it stays put
// whatever page you open, until unpinned. While the chat's project isn't the page's, a line under the header says so
// (ORR-588). The owner's chats, as many as they like and several on a project, are listed down the pane's left (ORR-870),
// newest first, running and ended: each row names its project and its first message, a running one is marked, each has
// an × that removes it at once, ending it first if it runs (ORR-935; what it filed stays), and a click opens it, an ended one as it was: writing in it starts its session again (ORR-884). New chat heads the list. On a narrow screen the list folds
// behind the button at the header's left, and opens over the conversation, closing on a tap outside it (ORR-899). Moving to another project, by page or
// picker, shows its newest running chat and leaves the others running; the picker marks the projects with one. What's
// held goes back in the box on a switch, so it never goes to another chat.
// While no launcher runs for its project, LauncherHint above the box says so, with the install command to copy, in place
// of the server's error (ORR-591).
const {open, large, chat, session, project, pinned, failed, chats, running, lands, start, send, clear, land, fresh, view, remove, answer, close, pin, resize, upload, show} = useChat()
const answering = ref<number | null>(null)
async function decide(message: number, allow: boolean, anyway = false) {
    answering.value = message
    const held = await answer(message, allow, anyway)
    // It came back saying what has changed: a double-click's second press isn't an answer to that.
    if (held) await new Promise(resolve => setTimeout(resolve, 800))
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
const editor = ref<{el?: HTMLTextAreaElement}>()
const field = computed(() => editor.value?.el)
const picker = ref<HTMLInputElement | null>(null)
const pane = ref<HTMLElement | null>(null)

/** Puts the focus in the box, unless the owner is typing in a field elsewhere on the page: the chat takes it only when
 * it's opened or acted in, never from another input (ORR-834). */
function focusField() {
    const at = document.activeElement
    if (at && at !== field.value && isTyping(at) && !pane.value?.contains(at)) return
    field.value?.focus()
}

/** The project of the page you're on, if it's one of them. */
const here = computed(() => {
    const on = route.params.project
    return typeof on === 'string' && projects.value.some(p => p.id === on) ? on : null
})
/** The project the chat would be about: the pinned one, else the one you're on; on a page of no project, a running
 * chat's when the pane has none, so the corner button brings you back to it (ORR-865, ORR-870); else the first. */
watch([pinned, here, projects, chats], (_now, was?: unknown[]) => {
    const [wasPinned, wasHere] = was ?? []
    if (pinned.value && projects.value.some(p => p.id === pinned.value)) project.value = pinned.value
    // Opening the page, or unpinning, moves it there; a chat changing meanwhile doesn't take back one picked in the
    // list (ORR-884).
    else if (here.value) project.value = here.value === wasHere && pinned.value === wasPinned && project.value ? project.value : here.value
    else if (!chat.value && running.value[0]) project.value = running.value[0].project
    else if (!project.value) project.value = projects.value[0]?.id ?? null
}, {immediate: true})
/** Where the issues the chat makes land: the running chat's, or the next one's. */
const landing = computed<ChatIssues>(() => chat.value && !chat.value.ended ? chat.value.issues : lands.value)
const LANDS: {value: ChatIssues, label: string}[] = [{value: 'todo', label: 'Todo'}, {value: 'backlog', label: 'Backlog'}]

const projectName = (id: string) => projects.value.find(p => p.id === id)?.name ?? id
const options = computed(() => projects.value.map(p => ({value: p.id, label: p.name})))
/** The projects with a chat running, which the picker marks. */
const chatting = computed(() => new Set(running.value.map(c => c.project)))

/** A wide enough screen docks the list beside the conversation; a narrower one opens it over it. */
const wide = ref(false)
let widths: MediaQueryList | undefined
const measure = () => wide.value = !!widths?.matches
onMounted(() => {
    widths = matchMedia('(min-width: 768px)')
    measure()
    widths.addEventListener('change', measure)
})
onBeforeUnmount(() => widths?.removeEventListener('change', measure))
/** Whether the list of chats shows: docked by default on a wide screen, folded on a narrow one. */
const listing = ref(false)
watch(wide, now => listing.value = now, {immediate: true})
const docked = computed(() => listing.value && wide.value)
/** A chat's row: its first message's first line, or that nothing's said yet. */
function firstLine(c: Chat) {
    const first = c.messages.find(m => m.from === 'owner' && m.text)
    return first ? (first.parts?.[0] ?? first.text).split('\n')[0] : 'Nothing said yet'
}
/** Opens a chat from the list: over the conversation, the list folds away again. */
function pick(id: string) {
    view(id)
    if (!wide.value) listing.value = false
}
/** Removes a chat from the list at once, ending it first if it runs (ORR-935): pressing it is the decision, so it asks
 * nothing. `removeFailed` says which one didn't go, and why. */
const removeFailed = ref<{id: string, why: string} | null>(null)
async function removeChat(id: string) {
    removeFailed.value = null
    try {
        await remove(id)
    } catch (error) {
        removeFailed.value = {id, why: errorMessage(error, 'remove')}
    }
}
/** New chat: what's held for the one on screen goes back in the box, and the next message starts a fresh one. */
function newChat() {
    unhold()
    fresh()
    if (!wide.value) listing.value = false
    nextTick(focusField)
}
/** Which project it's about: the chat's, else the one the first message will start it on. */
const about = computed(() => chat.value && !chat.value.ended ? chat.value.project : project.value)
/** The page's project, when it isn't the chat's: "here" isn't what the chat is about. */
const away = computed(() => here.value && about.value && here.value !== about.value ? here.value : null)
const {state: launch} = useLaunchState(() => about.value ?? '')
/** No launcher runs for its project: the hint says how to install one, and stands in for the error it brings. */
const unlaunched = computed(() => !!about.value && !!launch.value && !launch.value.launchers)
/** How long after the owner's last keystroke a run of held messages goes. */
const HOLD_MS = 2000
/** The owner's messages held to go together, shown as sent until they go. */
const held = ref<{key: number, text: string, images: {id: string, url: string}[]}[]>([])
let heldKey = 0
let holdTimer: ReturnType<typeof setTimeout> | undefined

/** What's held couldn't go (no launcher, or the server said no): it waits for Retry rather than trying every few
 * seconds on its own (ORR-530). */
const stuck = ref(false)

/** Nothing said yet: the pane greets you, with some things to ask. */
const empty = computed(() => !chat.value?.messages.length && !held.value.length)

/** Things to ask, one about the issue or doc you're on. */
const examples = computed(() => {
    const here = typeof route.params.issue === 'string' ? `Summarize ${route.params.issue}`
        : typeof route.params.doc === 'string' ? 'Summarize this doc'
        : null
    return [...here ? [here] : [], "What's left in the next release?", 'How do schedules work?', ...here ? [] : ['File an issue for…']]
})
function ask(example: string) {
    draft.value = example.endsWith('…') ? example.slice(0, -1) : example
    nextTick(focusField)
}

/** What the header says of its session: only that it can't start. Whether it's ready, starting or working isn't the
 * owner's to watch (ORR-883): the spinner shows a turn, and a prompt it waits on shows above the box. */
const state = computed(() => chat.value && !chat.value.ended && !session.value && chat.value.problem ? "Its session can't start" : '')
/** Whether the spinner shows: all the while its session works, whoever spoke last, so a reply partway through a turn doesn't
 * hide it (ORR-518); while it starts, only once the owner has said something it hasn't answered. */
const thinking = computed(() => {
    // From the first held message on, as if it had gone: holding, sending and the answer are one turn (ORR-535).
    if (held.value.length && !stuck.value) return true
    if (!chat.value || chat.value.ended || chat.value.problem) return false
    if (session.value?.state === 'working') return true
    const last = chat.value.messages.at(-1)
    return (!session.value || session.value.state === 'starting') && last?.from === 'owner' && !last.cleared
})

// The newest in sight as it comes, the spinner too.
watch(() => [open.value, chat.value?.messages.length, held.value.length, thinking.value], () => nextTick(() => list.value?.scrollTo({top: list.value.scrollHeight})))
watch(open, now => now && nextTick(focusField))

/** Where the session's context was last cleared: the messages before it, it no longer remembers. */
const cut = computed(() => chat.value?.messages.findLastIndex(m => m.cleared) ?? -1)

/** Starts the wait over, from now: what's held goes once it runs out. */
function restartHold() {
    clearTimeout(holdTimer)
    if (!held.value.length || stuck.value) return
    holdTimer = setTimeout(() => void flush(false), HOLD_MS)
}

/** Sends what's held as one message, starting the chat first when there's none yet: whether all of it went. What's held
 * stays if it can't go, and waits for Retry. `owner`: the owner asked for it, rather than the wait running out, which
 * never starts a chat on a hidden pane or after one ends (ORR-523). */
async function flush(owner = true): Promise<boolean> {
    clearTimeout(holdTimer)
    if (!held.value.length) return true
    // Busy with an image or another send: the wait starts over, and it goes once that's done.
    if (sending.value || uploading.value) {
        restartHold()
        return false
    }
    // What was held as a chat ended went back in the box (`unhold`); what's held since, for the ended chat, goes to it.
    if (!owner && !chat.value && !open.value) return false
    const run = held.value
    sending.value = true
    const texts = run.map(m => m.text).filter(Boolean)
    const ids = run.flatMap(m => m.images.map(i => i.id))
    const went = !!(chat.value || await start()) && await send(texts.length > 1 ? texts : texts[0] ?? '', ids)
    if (went) held.value = held.value.filter(m => !run.includes(m))
    stuck.value = !went
    sending.value = false
    // Held while that went: their wait starts now.
    restartHold()
    return went && !held.value.length
}

/** Puts what's held back in the box, unsent, for a chat that's ending: nothing goes after it on its own (ORR-523). */
function unhold() {
    clearTimeout(holdTimer)
    stuck.value = false
    if (!held.value.length) return
    draft.value = [...held.value.map(m => m.text), draft.value].filter(t => t.trim()).join('\n\n')
    images.value = [...held.value.flatMap(m => m.images), ...images.value]
    held.value = []
}

/** Closes the pane (× or Esc), leaving its chat running: what's held still goes to it. With no chat running, what's
 * held goes back in the box rather than starting one. */
function shut() {
    if (!chat.value || chat.value.ended) unhold()
    close()
}

/** Takes a held message back before it goes: into the box when the box is empty. */
function takeBack(key: number) {
    const message = held.value.find(m => m.key === key)
    if (!message) return
    held.value = held.value.filter(m => m !== message)
    if (!held.value.length) stuck.value = false
    if (!draft.value.trim() && !images.value.length) {
        draft.value = message.text
        images.value = message.images
    }
    restartHold()
    focusField()
}

/** Holds what's in the composer to go with the rest (`now`: sends it all at once). A slash command goes at once, after
 * what's held, and waits in the box while that can't go; `/clear` clears the running chat's context instead, and with
 * none running there's nothing to clear. */
async function submit(now = false) {
    const text = draft.value.trim()
    if (uploading.value) return
    if (/^\/[a-z][\w-]*(\s|$)/i.test(text) && !images.value.length) {
        if (!await flush()) return
        sending.value = true
        if (text === '/clear') {
            if (!chat.value || chat.value.ended || await clear()) draft.value = ''
        } else {
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
    } else if (event.key === 'Escape' && held.value.length && !draft.value.trim() && !images.value.length) {
        // In an empty box, takes the last one back, rather than closing the pane.
        event.preventDefault()
        event.stopPropagation()
        const last = held.value.at(-1)
        if (last) takeBack(last.key)
    }
}
// Typing the next part puts the wait off.
watch(draft, () => restartHold())
// Opened again, what was held while it was hidden gets its wait.
watch(open, shown => shown && restartHold())
watch(() => chat.value?.ended, over => over && unhold())
// Another project's chat, or none yet: what was held for the last one doesn't go to it.
watch(about, (now, was) => now !== was && unhold())
// Another chat on the same project, picked in the list: the same.
watch(() => chat.value?.id, (now, was) => now && was && now !== was && unhold())
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
    focusField()
}
const {over, on: drop} = useImageDrop(attach)
</script>

<template>
  <button
      v-if="!open"
      type="button"
      class="fixed right-4 bottom-4 z-40 inline-flex h-8 items-center gap-1.5 rounded-lg bg-panel px-3.5 text-[13px] text-fg shadow-md ring-1 ring-line transition hover:tint"
      title="Chat about a project: an agent answers and makes issues"
      @click="show()"
  >
    <svg
        class="size-4 text-accent-fill"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
    ><path d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" /></svg>
    Agent
  </button>

  <section
      v-else
      ref="pane"
      class="fixed right-4 bottom-4 z-40 flex w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl"
      :class="large ? 'h-[calc(100dvh-2rem)] sm:w-[min(56rem,calc(100vw-2rem))]' : ['h-[calc(100dvh-2rem)] sm:h-[min(40rem,calc(100dvh-2rem))]', docked ? 'sm:w-[min(41rem,calc(100vw-2rem))]' : 'sm:w-[min(28rem,calc(100vw-2rem))]']"
      aria-label="Chat"
      v-on="drop"
      @keydown.esc="shut"
  >
    <ImageDropOverlay v-if="over" />
    <!-- Over the chat, a tap anywhere outside the list closes it, as Esc does (ORR-899). -->
    <div v-if="listing && !docked" class="absolute inset-0 z-10 bg-black/10" data-testid="chat-list-backdrop" aria-hidden="true" @click="listing = false" />
    <aside
        v-if="listing"
        class="flex shrink-0 flex-col border-r border-line"
        :class="docked ? 'w-52 bg-well/50' : 'absolute inset-y-0 left-0 z-10 w-[min(17rem,85%)] bg-panel shadow-xl'"
        aria-label="Your chats"
        data-testid="chat-list"
        @keydown.esc.stop="!docked && (listing = false)"
    >
      <div class="flex items-center gap-1 p-2">
        <UiButton size="sm" class="flex-1 justify-start" title="Start a fresh chat: the others keep running" @click="newChat">
          <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
          New chat
        </UiButton>
        <UiButton v-if="!docked" variant="ghost" size="xs" square aria-label="Hide your chats" title="Hide" @click="listing = false">
          <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 18 18 6M6 6l12 12" /></svg>
        </UiButton>
      </div>
      <ul class="flex flex-1 flex-col gap-0.5 overflow-y-auto px-1.5 pb-2">
        <li v-for="c in chats" :key="c.id" class="group relative">
          <button
              type="button"
              class="flex w-full min-w-0 flex-col rounded-lg px-2.5 py-1.5 text-left transition hover:bg-hover"
              :class="[c.id === chat?.id && 'bg-hover', 'pr-7']"
              :aria-current="c.id === chat?.id ? 'true' : undefined"
              :title="`${projectName(c.project)}: ${firstLine(c)}${c.ended ? ' (ended, to read)' : ''}`"
              @click="pick(c.id)"
          >
            <span class="flex min-w-0 items-center gap-1.5 text-[11px] text-faint">
              <span v-if="!c.ended" class="size-1.5 shrink-0 rounded-full bg-accent-fill" />
              <span class="truncate">{{ projectName(c.project) }}</span>
              <span class="sr-only">{{ c.ended ? '(ended)' : '(running)' }}</span>
            </span>
            <span class="truncate text-[13px]" :class="c.ended ? 'text-muted' : 'text-fg'">{{ firstLine(c) }}</span>
          </button>
          <button
              type="button"
              class="absolute top-1.5 right-1 grid size-5 place-items-center rounded text-faint transition hover:bg-panel hover:text-fg sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
              :aria-label="`Remove the chat on ${projectName(c.project)}: ${firstLine(c)}`"
              :title="c.ended ? 'Remove this chat' : 'End and remove this chat'"
              @click="removeChat(c.id)"
          >
            <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 18 18 6M6 6l12 12" /></svg>
          </button>
          <p v-if="removeFailed?.id === c.id" role="alert" class="px-2.5 pb-1.5 text-xs text-rose-700 dark:text-rose-400">{{ removeFailed.why }}</p>
        </li>
        <li v-if="!chats.length" class="px-2.5 py-1.5 text-xs text-faint">No chats yet</li>
      </ul>
    </aside>
    <div class="flex min-w-0 flex-1 flex-col">
    <header class="flex items-center gap-1 border-b border-line py-2.5 pr-2.5 pl-2">
      <UiButton
          variant="ghost" size="xs" square :aria-expanded="listing"
          :aria-label="listing ? 'Hide your chats' : 'Show your chats'" :title="listing ? 'Hide your chats' : 'Your chats'"
          :class="listing && 'text-accent-700 dark:text-accent-400'"
          @click="listing = !listing"
      >
        <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg>
      </UiButton>
      <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-fg">
          <span>Chat</span>
          <template v-if="about">
            <span class="text-faint">·</span>
            <template v-if="options.length > 1">
              <PropertyPicker :model-value="project ?? ''" :options="options" label="Project" field small @update:model-value="pin(String($event))">
                <span class="truncate">{{ projectName(about) }}</span>
                <template #option="{option}">
                  <span class="min-w-0 flex-1 truncate" :title="option.label">{{ option.label }}</span>
                  <span v-if="chatting.has(option.value)" class="shrink-0 text-xs text-faint">chat running</span>
                </template>
              </PropertyPicker>
              <UiButton
                  variant="ghost" size="xs" square :aria-pressed="!!pinned"
                  :aria-label="pinned ? 'Unpin the project: follow the page you\'re on' : 'Pin the project: stay on it whatever page you open'"
                  :title="pinned ? 'Pinned: stays put. Unpin to follow the page' : 'Follows the page. Pin to stay on it'"
                  :class="pinned ? 'text-accent-700 dark:text-accent-400' : 'text-faint'"
                  @click="pin(pinned ? null : about)"
              >
                <svg class="size-3.5" viewBox="0 0 24 24" :fill="pinned ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5M9 3h6l-1 7 4 3v2H6v-2l4-3-1-7Z" /></svg>
              </UiButton>
            </template>
            <span v-else class="truncate">{{ projectName(about) }}</span>
          </template>
        </div>
        <!-- The line stays as it connects and works, so the header doesn't jump. -->
        <span v-if="chat" class="flex min-h-4 min-w-0 items-center gap-1.5 text-xs text-faint">
          <!-- Who's answering, once connected (ORR-811). The name gives way first on a narrow window, as in the sidebar. -->
          <template v-if="session">
            <span class="min-w-0 shrink-[100] truncate font-medium text-muted" :title="session.name" data-testid="chat-name">{{ nameBesideProject(session) }}</span>
            <span v-if="state" aria-hidden="true">·</span>
          </template>
          <span v-if="state" class="min-w-0 truncate">{{ state }}</span>
        </span>
        <span v-if="away" class="truncate text-xs text-muted" data-testid="chat-away">You're on <em>{{ projectName(away) }}</em>; this chat is about <em>{{ projectName(about!) }}</em></span>
      </div>
      <UiButton variant="ghost" size="xs" square class="max-sm:hidden" :aria-label="large ? 'Make the chat smaller' : 'Make the chat larger'" :title="large ? 'Smaller' : 'Larger'" @click="resize">
        <svg v-if="large" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 9V4.5M9 9H4.5M9 9 3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5 5.25 5.25" /></svg>
        <svg v-else class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" /></svg>
      </UiButton>
      <UiButton variant="ghost" size="xs" square :aria-label="chat && !chat.ended ? 'Close the chat, leaving it running' : 'Close the chat'" title="Close" @click="shut">
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

    <ol v-else ref="list" class="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4 text-[13px]" aria-label="Conversation">
      <template v-for="(m, i) in chat?.messages ?? []" :key="m.id">
      <li v-if="m.cleared" class="flex items-center gap-3 py-1 text-xs text-faint" role="separator" aria-label="Context cleared">
        <span class="h-px flex-1 bg-line" />Context cleared<span class="h-px flex-1 bg-line" />
      </li>
      <li v-else class="flex flex-col gap-1.5" :class="[m.from === 'owner' ? 'items-end' : 'items-start', i < cut && 'opacity-60']">
        <div v-if="m.images.length" class="flex flex-wrap justify-end gap-1.5">
          <img v-for="id in m.images" :key="id" :src="apiUrl(`/uploads/${id}`)" alt="" class="max-h-32 rounded-lg ring-1 ring-line">
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
        <ChatDocCard v-if="m.doc" :request="m.doc" :busy="answering === m.id" :ended="!!chat!.ended" @decide="allow => decide(m.id, allow)" />
        <ChatIssueCard v-if="m.issue" :request="m.issue" :project="chat!.project" :busy="answering === m.id" :ended="!!chat!.ended" @decide="allow => decide(m.id, allow)" />
        <div v-if="m.request" class="flex w-full flex-col gap-2 rounded-xl bg-well p-3 ring-1 ring-line" role="group" :aria-label="`Change ${CHAT_SETTINGS[m.request.setting]}`">
          <span class="text-xs text-faint">Asks to change a setting</span>
          <span class="text-fg"><span class="font-medium">{{ CHAT_SETTINGS[m.request.setting] }}</span>:
            <span class="text-muted line-through decoration-faint">{{ settingValue(m.request.from) }}</span> → <span class="break-all">{{ settingValue(m.request.to) }}</span></span>
          <RequestDrift v-if="m.request.state === 'asked'" :drifted="m.request.drifted" />
          <div v-if="m.request.state === 'asked' && !chat!.ended" class="flex gap-2">
            <UiButton variant="primary" size="sm" :disabled="answering === m.id" @click="decide(m.id, true, !!m.request.drifted?.length)">{{ m.request.drifted?.length ? 'Allow anyway' : 'Allow' }}</UiButton>
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
        <ScheduleRequestCard v-if="m.schedule" :request="m.schedule" :answerable="!chat!.ended" :busy="answering === m.id" @answer="allow => decide(m.id, allow, !!m.schedule!.drifted?.length)" />
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
          <RequestDrift v-if="m.release.state === 'asked'" :drifted="m.release.drifted" />
          <div v-if="m.release.state === 'asked' && !chat!.ended" class="flex gap-2">
            <UiButton variant="primary" size="sm" :disabled="answering === m.id" @click="decide(m.id, true, !!m.release.drifted?.length)">{{ m.release.drifted?.length ? 'Allow anyway' : 'Allow' }}</UiButton>
            <UiButton size="sm" :disabled="answering === m.id" @click="decide(m.id, false)">Deny</UiButton>
          </div>
          <span v-else class="text-xs" :class="m.release.state === 'allowed' ? 'text-emerald-600 dark:text-emerald-400' : 'text-faint'">{{ m.release.state === 'asked' ? 'Not answered' : ANSWERED[m.release.state] }}</span>
        </div>
        <div
v-if="m.milestone" class="flex w-full flex-col gap-2 rounded-xl bg-well p-3 ring-1 ring-line" role="group"
             :aria-label="m.milestone.changes.some(c => c.from !== undefined) ? `Change milestone ${m.milestone.title}` : `Make milestone ${m.milestone.title}`">
          <span class="text-xs text-faint">{{ m.milestone.changes.some(c => c.from !== undefined) ? `Asks to change milestone ${m.milestone.id}` : 'Asks to make a milestone' }}</span>
          <span class="font-medium text-fg">{{ m.milestone.title }}</span>
          <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
            <template v-for="c in m.milestone.changes.filter(c => c.field !== 'title' || c.from !== undefined)" :key="c.field">
              <dt class="text-muted">{{ CHAT_MILESTONE_FIELDS[c.field] }}</dt>
              <dd class="min-w-0 break-words whitespace-pre-wrap text-fg">
                <template v-if="c.from !== undefined"><span class="text-muted line-through decoration-faint">{{ settingValue(c.from) }}</span> → </template>{{ settingValue(c.to) }}
              </dd>
            </template>
          </dl>
          <RequestDrift v-if="m.milestone.state === 'asked'" :drifted="m.milestone.drifted" />
          <div v-if="m.milestone.state === 'asked' && !chat!.ended" class="flex gap-2">
            <UiButton variant="primary" size="sm" :disabled="answering === m.id" @click="decide(m.id, true, !!m.milestone.drifted?.length)">{{ m.milestone.drifted?.length ? 'Allow anyway' : 'Allow' }}</UiButton>
            <UiButton size="sm" :disabled="answering === m.id" @click="decide(m.id, false)">Deny</UiButton>
          </div>
          <span v-else class="text-xs" :class="m.milestone.state === 'allowed' ? 'text-emerald-600 dark:text-emerald-400' : 'text-faint'">{{ m.milestone.state === 'asked' ? 'Not answered' : ANSWERED[m.milestone.state] }}</span>
        </div>
        <div v-if="m.move" class="flex w-full flex-col gap-2 rounded-xl bg-well p-3 ring-1 ring-line" role="group" :aria-label="`Move ${m.move.body.ids.join(', ')}`">
          <span class="text-xs text-faint">Asks to move {{ m.move.body.ids.length === 1 ? 'an issue' : `${m.move.body.ids.length} issues` }}, as you</span>
          <ul class="flex flex-col gap-1.5 text-[13px]">
            <li v-for="one in movedIssues(m.move.changes)" :key="one.issue" class="flex min-w-0 flex-col">
              <span class="min-w-0 truncate"><NuxtLink :to="`/p/${chat!.project}/issues/${one.issue}`" class="font-medium text-accent-700 hover:underline dark:text-accent-400">{{ one.issue }}</NuxtLink> <span class="text-fg">{{ one.title }}</span></span>
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
          <ul v-if="m.move.state === 'asked' && m.move.drifted?.length" class="flex flex-col gap-0.5 text-xs text-amber-800 dark:text-amber-400" data-testid="move-drifted">
            <li>Changed since it asked:</li>
            <li v-for="d in m.move.drifted" :key="`${d.issue} ${d.field}`">{{ d.issue }} is now {{ d.field === 'status' ? statusName(d.to) : `assigned to ${d.to ?? 'nobody'}` }} (was {{ d.field === 'status' ? statusName(d.from) : d.from ?? 'nobody' }})</li>
          </ul>
          <div v-if="m.move.state === 'asked' && !chat!.ended" class="flex gap-2">
            <UiButton variant="primary" size="sm" :disabled="answering === m.id" @click="decide(m.id, true, !!m.move.drifted?.length)">{{ m.move.drifted?.length ? 'Move anyway' : 'Allow' }}</UiButton>
            <UiButton size="sm" :disabled="answering === m.id" @click="decide(m.id, false)">Deny</UiButton>
          </div>
          <span v-else class="text-xs" :class="m.move.state === 'allowed' ? 'text-emerald-600 dark:text-emerald-400' : 'text-faint'">{{ m.move.state === 'asked' ? 'Not answered' : ANSWERED[m.move.state] }}</span>
        </div>
      </li>
      </template>
      <!-- What's held to go together, looking sent: the owner needn't watch it wait (ORR-535). -->
      <li v-for="m in held" :key="`held-${m.key}`" class="flex flex-col items-end gap-1.5">
        <div v-if="m.images.length" class="flex flex-wrap justify-end gap-1.5">
          <img v-for="image in m.images" :key="image.id" :src="image.url" alt="" class="max-h-32 rounded-lg ring-1 ring-line">
        </div>
        <div v-if="m.text" class="max-w-[85%] rounded-2xl rounded-br-md bg-accent-500/15 px-3 py-2 whitespace-pre-wrap text-fg">{{ m.text }}</div>
      </li>
      <li v-if="held.length && stuck" class="flex items-center justify-end gap-1 text-[11px] text-rose-700 dark:text-rose-400" aria-live="polite">
        Not sent ·
        <button type="button" class="hover:underline disabled:opacity-50" :disabled="sending" @click="flush()">Retry</button>
      </li>
      <li v-if="thinking" class="flex items-center px-1 py-2 text-lg text-faint" aria-live="polite" aria-label="Thinking…">
        <UiSpinner />
      </li>
    </ol>

    <!-- What its session asks permission for, answered here while the pane is open (ORR-750). -->
    <div v-if="session?.state === 'waiting'" class="px-3 pt-2">
      <PermissionPrompt :session="session" :hideable="false" class="w-full! max-w-none!" />
    </div>
    <!-- An ended chat takes a message too: it starts its session again, on the same conversation (ORR-884). -->
    <form class="flex flex-col gap-2 p-3" @submit.prevent="submit(true)">
      <LauncherHint v-if="unlaunched" :project="about!" chat />
      <p v-else-if="failed" class="px-1 text-xs text-rose-700 dark:text-rose-400">{{ failed }}</p>
      <div class="flex flex-col gap-2 rounded-2xl bg-well p-2 ring-1 ring-line transition focus-within:ring-accent-500/50">
        <div v-if="images.length || uploading" class="flex flex-wrap gap-1.5 px-1 pt-1">
          <div v-for="(image, i) in images" :key="image.id" class="relative">
            <img :src="image.url" alt="" class="size-14 rounded-lg object-cover ring-1 ring-line">
            <button type="button" class="absolute -top-1.5 -right-1.5 grid size-4 place-items-center rounded-full bg-fg text-[10px] text-panel" :aria-label="`Remove image ${i + 1}`" @click="images.splice(i, 1)">×</button>
          </div>
          <span v-if="uploading" class="flex size-14 flex-col items-center justify-center gap-0.5 rounded-lg text-[11px] text-faint ring-1 ring-line"><UiSpinner />Adding…</span>
        </div>
        <MarkdownField
            ref="editor"
            v-model="draft"
            enter-sends
            rows="1"
            aria-label="Message"
            placeholder="Ask anything…"
            title="Enter sends (quick ones in a row go together); ⌘-Enter sends now; Shift-Enter for a new line; ⌘E or ``` for a code block"
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
    </div>
  </section>
</template>

