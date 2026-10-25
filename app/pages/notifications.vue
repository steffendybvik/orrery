<script setup lang="ts">
import type {Notice} from '#shared/roadmap'

// The bell, larger: every agent's comment with its whole body, those waiting on the owner first. The
// cleared ones stay readable here under Cleared. Leaving the page marks them read, as closing the bell does.
useHead({title: 'Notifications · Orrery'})
type Show = 'inbox' | 'waiting' | 'cleared'
const ASKS = {decision: 'Needs your decision', feedback: 'Needs your feedback'}
const isWaiting = (n: Notice) => !!n.asks && !n.answered
const {notices, seenAt, seen, clear} = useInbox()
const {projects} = useRoadmaps()
const {open: openIssue} = useIssueLink()
const {who} = useOwner()

const all = ref<Notice[]>([])
const loaded = ref(false)
const show = ref<Show>('inbox')
async function load() {
    all.value = await $fetch<Notice[]>('/api/notices', {query: {all: 'true'}}).catch(() => all.value)
    loaded.value = true
}
onMounted(load)
// A new notice, or one cleared in the bell, reaches the bell first.
watch(notices, load)
onBeforeUnmount(seen)

const inbox = computed(() => all.value.filter(n => !n.cleared))
const lists = computed<Record<Show, Notice[]>>(() => ({
    inbox: inbox.value,
    waiting: inbox.value.filter(isWaiting),
    cleared: all.value.filter(n => n.cleared).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
}))
const shown = computed(() => lists.value[show.value])
const options = computed(() => [
    {value: 'inbox' as const, label: `Inbox ${lists.value.inbox.length}`},
    {value: 'waiting' as const, label: `Waiting on you ${lists.value.waiting.length}`},
    {value: 'cleared' as const, label: 'Cleared'},
])
const read = computed(() => inbox.value.filter(n => n.createdAt <= seenAt.value && !isWaiting(n)).length)
const isNew = (n: Notice) => !n.cleared && (n.createdAt > seenAt.value || isWaiting(n))
const projectName = (id: string) => projects.value.find(p => p.id === id)?.name ?? id
const when = (iso: string) => new Date(iso).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'})

async function drop(ids?: number[]) {
    await clear(ids)
    await load()
}
</script>

<template>
  <PageHeader>
    <svg class="size-4 shrink-0 text-accent-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
    <h1 class="truncate text-sm font-medium">Notifications</h1>
  </PageHeader>

  <ViewToolbar>
    <SegmentedControl v-model="show" :options="options" />
    <template #end>
      <button v-if="read && show !== 'cleared'" type="button" class="rounded-md px-2 py-1 text-xs text-muted hover:bg-hover hover:text-fg" :title="`Clear the ${read} read`" @click="drop()">Clear read</button>
    </template>
  </ViewToolbar>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <ul class="mx-auto flex max-w-3xl flex-col gap-3 px-3 py-4 sm:px-4">
      <li
          v-for="notice in shown"
          :key="notice.id"
          class="group relative rounded-xl bg-panel ring-1 transition-colors"
          :class="isWaiting(notice) && !notice.cleared ? 'ring-accent-500/40' : 'ring-line'"
      >
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-4 py-2.5 pr-12 text-[13px]">
          <span v-if="isNew(notice)" class="size-2 shrink-0 rounded-full bg-accent-500" />
          <PersonAvatar :name="notice.createdBy" :size="20" />
          <span class="font-medium text-fg">{{ who(notice.createdBy) }}</span>
          <span class="text-faint">on</span>
          <button type="button" class="flex min-w-0 items-center gap-2 rounded-md px-1 text-left hover:bg-hover" @click="openIssue(notice.project, notice.issue)">
            <span class="font-mono text-xs text-faint">{{ notice.issue }}</span>
            <span class="truncate text-fg">{{ notice.title }}</span>
          </button>
          <span class="text-xs text-faint">in {{ projectName(notice.project) }}</span>
          <span class="ml-auto shrink-0 text-xs text-faint" :title="when(notice.createdAt)">{{ ago(notice.createdAt) }}</span>
        </div>
        <div class="px-4 py-3">
          <span v-if="isWaiting(notice)" class="mb-2 inline-block rounded-full bg-accent-500/10 px-2 py-0.5 text-[11px] font-medium text-accent-700 ring-1 ring-accent-500/30 dark:text-accent-300">{{ ASKS[notice.asks!] }}</span>
          <span v-else-if="notice.asks" class="mb-2 inline-block rounded-full px-2 py-0.5 text-[11px] text-faint ring-1 ring-line">Answered</span>
          <MarkdownView :source="notice.body" />
        </div>
        <button
            v-if="!notice.cleared"
            type="button"
            class="absolute top-2 right-2 grid size-7 place-items-center rounded-md text-faint opacity-0 group-hover:opacity-100 hover:bg-active hover:text-fg focus-visible:opacity-100"
            title="Clear"
            aria-label="Clear this notice"
            @click="drop([notice.id])"
        >
          <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </li>
    </ul>
    <div v-if="loaded && !shown.length" class="flex flex-col items-center gap-2 px-4 py-24 text-center">
      <p class="text-sm text-muted">{{ {inbox: 'No comments from agents.', waiting: 'Nothing waiting on you.', cleared: 'Nothing cleared yet.'}[show] }}</p>
      <p class="text-xs text-faint">Agents' comments on issues land here and in the bell; questions for you stay on top until you answer them on the issue.</p>
    </div>
  </div>
</template>
