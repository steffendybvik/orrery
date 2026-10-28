<script setup lang="ts">
// The owner's chat (useChat): a button in the corner of every page, and the pane it opens there. With no chat running
// the pane offers to start one on the project you're on; once started, its session's state shows in the header and
// the conversation below, newest at the bottom. Enter sends (Shift+Enter for a new line), and an image pasted or
// dropped goes with the message. End chat stops the session; closing the pane leaves it running.
const {open, chat, session, project, failed, chats, start, send, end, upload, show} = useChat()
const {projects} = useRoadmaps()
const route = useRoute()

const draft = ref('')
const images = ref<{id: string, url: string}[]>([])
const uploading = ref(0)
const sending = ref(false)
const starting = ref(false)
const list = ref<HTMLElement | null>(null)
const field = ref<HTMLTextAreaElement | null>(null)

/** The project the chat would be about: the one you're on, else the first. */
watch([() => route.params.project, projects], ([here]) => {
    if (!project.value || here) project.value = typeof here === 'string' && projects.value.some(p => p.id === here) ? here : project.value ?? projects.value[0]?.id ?? null
}, {immediate: true})
const projectName = (id: string) => projects.value.find(p => p.id === id)?.name ?? id
const options = computed(() => projects.value.map(p => ({value: p.id, label: p.name})))

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

async function begin() {
    starting.value = true
    await start()
    starting.value = false
    nextTick(() => field.value?.focus())
}

async function submit() {
    const text = draft.value.trim()
    if (!text && !images.value.length || sending.value || uploading.value) return
    sending.value = true
    if (await send(text, images.value.map(i => i.id))) {
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
      :title="chats.length ? 'Back to your chat' : 'Chat with Claude about a project: it answers and makes issues'"
      @click="show()"
  >
    <svg class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.076-4.076a1.526 1.526 0 0 1 1.037-.443 48.282 48.282 0 0 0 5.68-.494c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" /></svg>
    Chat
    <span v-if="chats.length" class="size-2 rounded-full bg-white" aria-label="A chat is running" />
  </button>

  <section
      v-else
      class="fixed right-4 bottom-4 z-40 flex h-[min(40rem,calc(100dvh-2rem))] w-[min(28rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl"
      aria-label="Chat"
      @keydown.esc="open = false"
  >
    <header class="flex items-center gap-2 border-b border-line px-4 py-3">
      <div class="flex min-w-0 flex-1 flex-col">
        <span class="truncate text-[13px] font-medium text-fg">Chat{{ chat ? ` · ${projectName(chat.project)}` : '' }}</span>
        <span v-if="state" class="flex items-center gap-1.5 text-xs text-faint">
          <SessionDot v-if="session" :session="session" />{{ state }}
        </span>
      </div>
      <UiButton v-if="chat && !chat.ended" variant="danger-ghost" size="xs" @click="end">End chat</UiButton>
      <UiButton variant="ghost" size="xs" square aria-label="Close the chat; it keeps running" title="Close (it keeps running)" @click="open = false">
        <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 18 18 6M6 6l12 12" /></svg>
      </UiButton>
    </header>

    <div v-if="!chat || chat.ended && !chat.messages.length" class="flex flex-1 flex-col justify-center gap-3 px-5 text-[13px] text-muted">
      <p>Ask Claude about a project: its code, its roadmap, its docs. It makes issues and comments when you ask, and works on nothing itself.</p>
      <PropertyPicker v-if="options.length > 1" :model-value="project ?? ''" :options="options" label="Project" field class="self-start" @update:model-value="project = String($event)">
        <span class="truncate">{{ project ? projectName(project) : 'Pick a project' }}</span>
      </PropertyPicker>
      <UiButton variant="primary" size="md" class="self-start" :disabled="!project || starting" @click="begin">
        {{ starting ? 'Starting…' : `Chat about ${project ? projectName(project) : 'a project'}` }}
      </UiButton>
      <p v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>
    </div>

    <template v-else>
      <ol ref="list" class="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-3 text-[13px]">
        <li v-if="!chat.messages.length" class="text-faint">Ask away. It reads {{ projectName(chat.project) }}'s code, roadmap and docs to answer.</li>
        <li v-for="m in chat.messages" :key="m.id" class="flex flex-col gap-1.5" :class="m.from === 'owner' ? 'items-end' : 'items-start'">
          <div v-if="m.images.length" class="flex flex-wrap justify-end gap-1.5">
            <img v-for="id in m.images" :key="id" :src="`/api/uploads/${id}`" alt="" class="max-h-32 rounded-lg ring-1 ring-line">
          </div>
          <div v-if="m.from === 'owner' && m.text" class="max-w-[85%] rounded-2xl rounded-br-md bg-accent-500/15 px-3 py-2 whitespace-pre-wrap text-fg">{{ m.text }}</div>
          <MarkdownView v-else-if="m.text" :source="m.text" class="max-w-full text-[13px]" />
        </li>
        <li v-if="thinking" class="text-xs text-faint" aria-live="polite">Thinking…</li>
        <li v-if="!session && chat.problem && !chat.ended" class="text-xs text-rose-600 dark:text-rose-400" role="alert">{{ chat.problem }}</li>
        <li v-if="chat.ended" class="text-xs text-faint">This chat has ended.</li>
      </ol>

      <form v-if="!chat.ended" class="flex flex-col gap-2 border-t border-line p-3" @submit.prevent="submit">
        <div v-if="images.length || uploading" class="flex flex-wrap gap-1.5">
          <div v-for="(image, i) in images" :key="image.id" class="relative">
            <img :src="image.url" alt="" class="size-14 rounded-lg object-cover ring-1 ring-line">
            <button type="button" class="absolute -top-1.5 -right-1.5 grid size-4 place-items-center rounded-full bg-fg text-[10px] text-panel" :aria-label="`Remove image ${i + 1}`" @click="images.splice(i, 1)">×</button>
          </div>
          <span v-if="uploading" class="grid size-14 place-items-center rounded-lg text-[11px] text-faint ring-1 ring-line">Adding…</span>
        </div>
        <textarea
            ref="field"
            v-model="draft"
            rows="2"
            aria-label="Message"
            placeholder="Ask, or ask for an issue. Paste an image to show it."
            class="field-sizing-content max-h-40 min-h-10 resize-none rounded-lg bg-well px-3 py-2 text-[13px] text-fg ring-1 ring-line placeholder:text-faint focus:ring-accent-500/50 focus:outline-none"
            @keydown="onKey"
            @paste="onPaste"
            @dragover.prevent
            @drop.prevent="attach([...$event.dataTransfer?.files ?? []])"
        />
        <div class="flex items-center gap-2">
          <span v-if="failed" class="truncate text-xs text-rose-600 dark:text-rose-400">{{ failed }}</span>
          <UiButton type="submit" variant="primary" size="sm" class="ml-auto" :disabled="sending || !!uploading || !draft.trim() && !images.length">
            Send <KeyHint class="bg-white/20 text-white ring-0">↵</KeyHint>
          </UiButton>
        </div>
      </form>
    </template>
  </section>
</template>
