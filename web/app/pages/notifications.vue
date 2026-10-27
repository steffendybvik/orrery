<script setup lang="ts">
import type {Notice} from '#shared/roadmap'
import {noticeKey} from '#shared/roadmap'

// The bell, larger: every agent's comment with its whole body, newest first, and their proposals waiting
// on the owner (which go when decided, not cleared); a card opens its issue. The cleared ones stay readable here under Cleared. Opening the page marks them read;
// the ones that were new keep their dot until you leave.
useHead({title: 'Notifications · Orrery'})
type Show = 'inbox' | 'waiting' | 'cleared'
const ASKS = {decision: 'Needs your decision', feedback: 'Needs your feedback'}
const {notices, lists, seenAt, seen, load, clear} = useInbox()
const {byId} = useRoadmaps()
const {open: openIssue} = useIssueLink()
const {who} = useOwner()

const show = ref<Show>('inbox')
const since = ref(seenAt.value)
onMounted(() => {
    since.value = seenAt.value
    seen()
    load('waiting')
    load('inbox')
})
// Those arriving while it's open are read too, and keep their dot.
watch(notices, () => seen())
watch(show, now => {
    if (!lists.value[now].loaded) load(now)
})

// Newest first, the waiting ones among the rest by time; their ring marks them.
const shown = computed(() => show.value === 'inbox'
    ? [...lists.value.waiting.items, ...lists.value.inbox.items].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)
    : lists.value[show.value].items)
const loaded = computed(() => lists.value[show.value].loaded && (show.value !== 'inbox' || lists.value.waiting.loaded))
const options = computed(() => [
    {value: 'inbox' as const, label: 'Inbox'},
    {value: 'waiting' as const, label: `Waiting on you ${lists.value.waiting.items.length}`},
    {value: 'cleared' as const, label: 'Cleared'},
])
const isNew = (n: Notice) => !n.cleared && (n.created_at > since.value || isWaiting(n))
/** Only comments clear; a proposal waits until it's decided. */
const clearable = computed(() => shown.value.filter(n => !n.proposal))
const choices = (n: Notice) => n.proposal?.choices ? ` · ${n.proposal.choices} ${n.proposal.choices === 1 ? 'choice' : 'choices'}` : ''
const projectName = (id: string) => byId(id)?.name ?? id
const when = (iso: string) => new Date(iso).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'})

/** A card opens its issue, unless the click was on a link or button in it, or ended a text selection. */
function openCard(notice: Notice, event: MouseEvent) {
    if ((event.target as HTMLElement).closest('a, button') || window.getSelection()?.toString()) return
    openIssue(notice.project, notice.issue)
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
      <UiButton v-if="show === 'inbox' && lists.inbox.items.length" variant="ghost" size="xs" title="Clear every read one, not those waiting on you" @click="clear()">Clear read</UiButton>
      <UiButton v-if="show !== 'cleared' && clearable.length" variant="ghost" size="xs" :title="`Clear these ${clearable.length}; they stay under Cleared`" @click="clear(clearable.map(n => n.id))">Clear all</UiButton>
    </template>
  </ViewToolbar>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <ul class="mx-auto flex max-w-3xl flex-col gap-3 px-3 py-4 sm:px-4">
      <li
          v-for="notice in shown"
          :key="noticeKey(notice)"
          class="group relative cursor-pointer rounded-xl bg-panel ring-1 transition-colors hover:bg-hover focus-visible:ring-accent-500/60 focus-visible:outline-none"
          :class="isWaiting(notice) ? 'ring-accent-500/40' : 'ring-line hover:ring-faint/50'"
          tabindex="0"
          role="link"
          :aria-label="`${notice.issue}: ${notice.title}`"
          @click="openCard(notice, $event)"
          @keydown.enter.self="openIssue(notice.project, notice.issue)"
      >
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-4 py-2.5 pr-12 text-[13px]">
          <span v-if="isNew(notice)" class="size-2 shrink-0 rounded-full bg-accent-500" />
          <PersonAvatar :name="notice.created_by" :size="20" />
          <span class="font-medium text-fg">{{ who(notice.created_by) }}</span>
          <span class="text-faint">{{ notice.proposal ? 'proposed' : 'on' }}</span>
          <span class="flex min-w-0 items-center gap-2 px-1">
            <span class="font-mono text-xs text-faint">{{ notice.issue }}</span>
            <span class="truncate text-fg group-hover:underline">{{ notice.title }}</span>
          </span>
          <span class="text-xs text-faint">in {{ projectName(notice.project) }}</span>
          <span class="ml-auto shrink-0 text-xs text-faint" :title="when(notice.created_at)">{{ ago(notice.created_at) }}</span>
        </div>
        <div class="px-4 py-3">
          <span v-if="isWaiting(notice)" class="mb-2 inline-block rounded-full bg-accent-500/10 px-2 py-0.5 text-[11px] font-medium text-accent-700 ring-1 ring-accent-500/30 dark:text-accent-300">{{ notice.proposal ? `Proposal: needs your decision${choices(notice)}` : ASKS[notice.asks!] }}</span>
          <span v-else-if="notice.asks" class="mb-2 inline-block rounded-full px-2 py-0.5 text-[11px] text-faint ring-1 ring-line">{{ notice.answered ? 'Answered' : 'Cleared unanswered' }}</span>
          <MarkdownView :source="notice.body" class="text-[14px] leading-6" />
        </div>
        <button
            v-if="!notice.cleared && !notice.proposal"
            type="button"
            class="absolute top-2 right-2 grid size-7 place-items-center rounded-md text-faint opacity-0 group-hover:opacity-100 hover:bg-active hover:text-fg focus-visible:opacity-100"
            title="Clear"
            aria-label="Clear this notice"
            @click="clear([notice.id])"
        >
          <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </li>
    </ul>
    <div v-if="show !== 'waiting' && lists[show].more" class="flex justify-center pb-6">
      <UiButton @click="load(show, true)">Show older</UiButton>
    </div>
    <div v-if="loaded && !shown.length" class="flex flex-col items-center gap-2 px-4 py-24 text-center">
      <p class="text-sm text-muted">{{ {inbox: 'No comments from agents.', waiting: 'Nothing waiting on you.', cleared: 'Nothing cleared yet.'}[show] }}</p>
      <p class="text-xs text-faint">Agents' comments on issues land here and in the bell; questions and proposals for you wait under Waiting on you until you answer or decide them on the issue.</p>
    </div>
  </div>
</template>
