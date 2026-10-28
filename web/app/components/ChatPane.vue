<script setup lang="ts">
import {CHAT_SCHEDULE_FIELDS, CHAT_SETTINGS, scheduleValue, settingValue} from '#shared/roadmap'
import {Menu, MenuButton, MenuItem, MenuItems} from '@headlessui/vue'
import type {ChatIssues} from '#shared/roadmap'

// The owner's chat (useChat): a button in the corner of every page, and the pane it opens there, ready to type into.
// The first message starts a chat on the project in the header (the one you're on, or picked); once started, its
// session's state shows in the header and the conversation below, newest at the bottom. Enter sends (Shift+Enter for a new line), and an image pasted or
// dropped goes with the message. Closing the pane (×) ends the chat and stops its session; Esc closes it only before
// one starts, so a stray key doesn't end it. The pane can be made large (a phone's fills the screen either way). Beside
// Send, the owner picks where the issues it makes land, Todo or Backlog; the server holds the chat to it. A setting the
// chat asks to change shows from → to with Allow and Deny; only Allow saves it. So does a schedule it asks to make (each
// field it sets) or change (each from → to). Under each of Claude's replies, Copy takes its Markdown as written (on a
// wide screen it shows on hover or focus).
const {open, large, chat, session, project, failed, chats, lands, start, send, land, fresh, answer, close, resize, upload, show} = useChat()
const answering = ref<number | null>(null)
async function decide(message: number, allow: boolean) {
    answering.value = message
    await answer(message, allow)
    answering.value = null
}
const ANSWERED = {allowed: 'Allowed and saved', denied: 'Denied: nothing changed', expired: 'Expired: not answered in time, or asked again'}
const {projects} = useRoadmaps()
const route = useRoute()

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
const thinking = computed(() => !!chat.value && !chat.value.ended && !chat.value.problem && (!session.value || session.value.state === 'working')
    && chat.value.messages.at(-1)?.from === 'owner')

// The newest in sight as it comes.
watch(() => [open.value, chat.value?.messages.length], () => nextTick(() => list.value?.scrollTo({top: list.value.scrollHeight})))
watch(open, now => now && nextTick(() => field.value?.focus()))

/** Sends what's in the composer, starting the chat first when there's none yet. */
async function submit() {
    const text = draft.value.trim()
    if (!text && !images.value.length || sending.value || uploading.value) return
    sending.value = true
    if (chat.value?.ended) fresh()
    if ((chat.value || await start()) && await send(text, images.value.map(i => i.id))) {
        draft.value = ''
        images.value = []
    }
    sending.value = false
}

function onKey(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault()
        submit()
    }
}

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
}
function onPaste(event: ClipboardEvent) {
    const files = [...event.clipboardData?.files ?? []].filter(f => f.type.startsWith('image/'))
    if (!files.length) return
    event.preventDefault()
    attach(files)
}
</script>

<template>
  <button
      v-if="!open"
      type="button"
      class="fixed right-4 bottom-4 z-40 flex h-11 items-center gap-2 rounded-full bg-accent-500 pr-4 pl-3.5 text-sm font-medium text-white shadow-lg shadow-accent-600/30 transition hover:opacity-90"
      :title="chats.length ? 'Back to your chat: it is still running' : 'Chat with Claude about a project: it answers and makes issues'"
      @click="show()"
  >
    <svg class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.076-4.076a1.526 1.526 0 0 1 1.037-.443 48.282 48.282 0 0 0 5.68-.494c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" /></svg>
    Chat
    <span v-if="chats.length" class="size-2 rounded-full bg-white" aria-label="A chat is running" />
  </button>

  <section
      v-else
      class="fixed right-4 bottom-4 z-40 flex w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl"
      :class="large ? 'h-[calc(100dvh-2rem)] sm:w-[min(56rem,calc(100vw-2rem))]' : 'h-[min(40rem,calc(100dvh-2rem))] sm:w-[min(28rem,calc(100vw-2rem))]'"
      aria-label="Chat"
      @keydown.esc="!chat || chat.ended ? close() : undefined"
  >
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
      <li v-for="m in chat!.messages" :key="m.id" class="flex flex-col gap-1.5" :class="m.from === 'owner' ? 'items-end' : 'items-start'">
        <div v-if="m.images.length" class="flex flex-wrap justify-end gap-1.5">
          <img v-for="id in m.images" :key="id" :src="`/api/uploads/${id}`" alt="" class="max-h-32 rounded-lg ring-1 ring-line">
        </div>
        <div v-if="m.from === 'owner' && m.text" class="max-w-[85%] rounded-2xl rounded-br-md bg-accent-500/15 px-3 py-2 whitespace-pre-wrap text-fg">{{ m.text }}</div>
        <div v-else-if="m.text" class="group flex max-w-[92%] flex-col items-start gap-1">
          <div class="rounded-2xl rounded-bl-md bg-well px-3.5 py-2.5 ring-1 ring-line/60">
            <MarkdownView :source="m.text" class="text-[13px]" />
          </div>
          <CopyButton :text="m.text" name="this reply" class="transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100" />
        </div>
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
      </li>
      <li v-if="thinking" class="flex items-center gap-1 px-1 py-2" aria-live="polite" aria-label="Thinking…">
        <span v-for="i in 3" :key="i" class="size-1.5 animate-dot rounded-full bg-faint" :style="{animationDelay: `${(i - 1) * 0.15}s`}" />
      </li>
      <li v-if="chat!.ended" class="flex items-center gap-2 text-xs text-faint">
        This chat has ended.
        <button type="button" class="text-accent-600 hover:underline dark:text-accent-400" @click="fresh">Start another</button>
      </li>
    </ol>

    <form v-if="!chat?.ended || !chat.messages.length" class="flex flex-col gap-2 p-3" @submit.prevent="submit">
      <p v-if="failed" class="px-1 text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>
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
            class="field-sizing-content max-h-40 min-h-9 resize-none bg-transparent px-2 py-1.5 text-[13px] text-fg placeholder:text-faint focus:outline-none"
            @keydown="onKey"
            @paste="onPaste"
            @dragover.prevent
            @drop.prevent="attach([...$event.dataTransfer?.files ?? []])"
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
          <UiButton type="submit" variant="primary" size="xs" square class="rounded-full" aria-label="Send" title="Send (↵)" :disabled="sending || !!uploading || !about || !draft.trim() && !images.length">
            <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5m0 0-6 6m6-6 6 6" /></svg>
          </UiButton>
        </div>
      </div>
    </form>
  </section>
</template>
