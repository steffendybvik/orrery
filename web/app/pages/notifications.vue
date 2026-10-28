<script setup lang="ts">
import type {Notice} from '#shared/roadmap'
import {noticeKey} from '#shared/roadmap'

// The bell, larger: every agent's comment with its whole body, newest first, in one list with their questions
// and proposals waiting on the owner (which go when answered, decided or cleared; clearing a proposal leaves it
// pending); a card opens its issue. Opening the page marks them read; the ones that were new keep their dot
// until you leave.
useHead({title: 'Notifications · orrery'})
const {notices, lists, seenAt, seen, load, clear} = useInbox()
const {byId} = useRoadmaps()
const {open: openIssue} = useIssueLink()
const {newErrors} = useLoggedEvents()

const since = ref(seenAt.value)
onMounted(() => {
    since.value = seenAt.value
    seen()
    load('waiting')
    load('inbox')
})
// Those arriving while it's open are read too, and keep their dot.
watch(notices, () => seen())

// Newest first, the waiting ones among the rest by time; their ring marks them.
const shown = computed(() => [...lists.value.waiting.items, ...lists.value.inbox.items]
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id))
const loaded = computed(() => lists.value.inbox.loaded && lists.value.waiting.loaded)
const isNew = (n: Notice) => !n.cleared && (n.created_at > since.value || isWaiting(n))
const clearable = computed(() => shown.value.filter(n => !n.cleared))
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
    <template #end>
      <UiButton v-if="lists.inbox.items.length" variant="ghost" size="xs" title="Clear every read one, not those waiting on you" @click="clear()">Clear read</UiButton>
      <UiButton v-if="clearable.length" variant="ghost" size="xs" :title="`Clear these ${clearable.length}; a proposal stays pending on its issue`" @click="clear(clearable)">Clear all</UiButton>
    </template>
  </ViewToolbar>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <div v-if="newErrors.length" class="mx-auto max-w-3xl px-3 pt-4 sm:px-4">
      <NuxtLink to="/events?level=error" class="flex items-center gap-2 rounded-xl bg-panel px-4 py-2.5 text-[13px] ring-1 ring-rose-500/40 transition-colors hover:bg-hover">
        <span class="size-2 shrink-0 rounded-full bg-rose-500" />
        <span class="flex-1 text-fg">{{ newErrors.length }} new kind{{ newErrors.length === 1 ? '' : 's' }} of error: <span class="text-muted">{{ newErrors[0]?.message }}</span></span>
        <span class="shrink-0 text-xs text-faint">Events →</span>
      </NuxtLink>
    </div>
    <ul class="mx-auto flex max-w-3xl flex-col gap-3 px-3 py-4 sm:px-4">
      <li
          v-for="notice in shown"
          :key="noticeKey(notice)"
          class="group relative cursor-pointer rounded-xl bg-panel ring-1 transition-colors hover:bg-hover focus-visible:ring-accent-500/60 focus-visible:outline-none"
          :class="isWaiting(notice) ? 'ring-violet-500/40' : 'ring-line hover:ring-faint/50'"
          tabindex="0"
          role="link"
          :aria-label="`${notice.issue}: ${notice.title}`"
          @click="openCard(notice, $event)"
          @keydown.enter.self="openIssue(notice.project, notice.issue)"
      >
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-4 py-2.5 pr-12 text-[13px]">
          <span v-if="isNew(notice)" class="size-2 shrink-0 rounded-full bg-accent-500" />
          <span class="text-faint">{{ notice.proposal ? 'proposed' : 'on' }}</span>
          <span class="flex min-w-0 items-center gap-2 px-1">
            <span class="font-mono text-xs text-faint">{{ notice.issue }}</span>
            <span class="truncate text-fg group-hover:underline">{{ notice.title }}</span>
          </span>
          <span class="text-xs text-faint">in {{ projectName(notice.project) }}</span>
          <span class="ml-auto shrink-0 text-xs text-faint" :title="when(notice.created_at)">{{ ago(notice.created_at) }}</span>
        </div>
        <div class="px-4 py-3">
          <WaitingChip v-if="isWaiting(notice)" :asks="notice.asks!" :proposal="notice.proposal" class="mb-2" />
          <span v-else-if="notice.asks" class="mb-2 inline-block rounded-full px-2 py-0.5 text-[11px] text-faint ring-1 ring-line">{{ notice.answered ? 'Answered' : notice.proposal ? 'Cleared, still to decide' : 'Cleared unanswered' }}</span>
          <MarkdownView :source="notice.body" class="text-[14px] leading-6" />
        </div>
        <button
            v-if="!notice.cleared"
            type="button"
            class="absolute top-2 right-2 grid size-7 place-items-center rounded-md text-faint opacity-0 group-hover:opacity-100 hover:bg-active hover:text-fg focus-visible:opacity-100"
            title="Clear"
            aria-label="Clear this notice"
            @click="clear([notice])"
        >
          <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </li>
    </ul>
    <div v-if="lists.inbox.more" class="flex justify-center pb-6">
      <UiButton @click="load('inbox', true)">Show older</UiButton>
    </div>
    <div v-if="loaded && !shown.length" class="flex flex-col items-center gap-2 px-4 py-24 text-center">
      <p class="text-sm text-muted">No notifications.</p>
      <p class="text-xs text-faint">Agents' comments on issues land here and in the bell; their questions and proposals for you stay, ringed, until you answer or decide them on the issue, or clear them.</p>
    </div>
  </div>
</template>
