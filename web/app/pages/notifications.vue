<script setup lang="ts">
import type {Notice} from '#shared/roadmap'
import {noticeKey} from '#shared/roadmap'
import type {NoticeRow} from '~/composables/useInbox'

// The bell, larger, drawn as a timeline: agents' comments, with their questions and proposals waiting on the owner (which
// go when answered, decided or cleared; clearing a proposal leaves it pending), by day, one line per issue each day. A line
// opens in place to its full text, which marks it read; opening the page only resets the bell's count, so the
// filled dots down the line stay what's still to read.
useHead({title: 'Notifications · orrery'})
const {notices, lists, seen, load, markRead, clear} = useInbox()
const {byId} = useRoadmaps()
const {newErrors} = useLoggedEvents()
const {pathOf} = useIssueLink()

onMounted(() => {
    seen()
    load('waiting')
    load('inbox')
})
// Those arriving while it's open count as seen too, for the bell.
watch(notices, () => seen())

const shown = computed(() => [...lists.value.waiting.items, ...lists.value.inbox.items])
const days = computed(() => noticeDays(shown.value))
const loaded = computed(() => lists.value.inbox.loaded && lists.value.waiting.loaded)
const clearable = computed(() => shown.value.filter(n => !n.cleared))
const anyRead = computed(() => shown.value.some(n => n.read && !isWaiting(n)))
const projectName = (id: string) => byId(id)?.name ?? id
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'})
const when = (iso: string) => new Date(iso).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'})

/** What a line says it is: its count when it holds several, else its kind. */
function kind(row: NoticeRow): string {
    if (row.notices.length > 1) return `${row.notices.length} comments`
    const [only] = row.notices
    return only?.proposal ? 'proposal' : only?.asks ? 'asks' : 'comment'
}

/** The newest notice's first line, without its Markdown marks. */
function firstLine(row: NoticeRow): string {
    const line = (row.notices[0]?.body ?? '').split('\n').map(l => l.trim()).find(Boolean) ?? ''
    return line.replace(/^(#+\s+|>\s+|[-*]\s+)/, '').replace(/[*_`]/g, '')
}

const open = ref<string[]>([])
function toggle(row: NoticeRow) {
    if (open.value.includes(row.key)) return void (open.value = open.value.filter(k => k !== row.key))
    open.value = [...open.value, row.key]
    markRead(row.notices)
}
const dot = (row: NoticeRow) => row.waiting
    ? 'bg-violet-500 ring-violet-500'
    : row.unread ? 'bg-accent-500 ring-accent-500' : 'bg-canvas ring-faint'
const tint = (row: NoticeRow) => row.waiting ? 'bg-violet-500/10' : row.unread ? 'bg-accent-500/10' : ''
const clearOne = (notice: Notice) => clear([notice])
</script>

<template>
  <PageHeader>
    <svg class="size-4 shrink-0 text-accent-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
    <h1 class="truncate text-sm font-medium">Notifications</h1>
  </PageHeader>

  <ViewToolbar>
    <template #end>
      <UiButton v-if="anyRead" variant="ghost" size="xs" title="Clear every read one, not those waiting on you" @click="clear()">Clear read</UiButton>
      <UiButton v-if="clearable.length" variant="ghost" size="xs" :title="`Clear these ${clearable.length}; a proposal stays pending on its issue`" @click="clear(clearable)">Clear all</UiButton>
    </template>
  </ViewToolbar>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <div v-if="newErrors.length" class="mx-auto max-w-3xl px-3 pt-4 sm:px-4">
      <NuxtLink to="/events?level=error" class="flex items-center gap-2 rounded-xl bg-panel px-4 py-2.5 text-[13px] ring-1 ring-rose-500/40 transition-colors hover:tint">
        <span class="size-2 shrink-0 rounded-full bg-rose-500" />
        <span class="flex-1 text-fg">{{ newErrors.length }} new kind{{ newErrors.length === 1 ? '' : 's' }} of error: <span class="text-muted">{{ newErrors[0]?.message }}</span></span>
        <span class="shrink-0 text-xs text-faint">Events →</span>
      </NuxtLink>
    </div>
    <div v-for="day in days" :key="day.key" class="mx-auto max-w-5xl">
      <h2 class="sticky top-0 z-20 flex items-baseline gap-2 border-y-2 border-faint/40 bg-canvas px-3 py-1.5 text-[13px] font-semibold text-fg sm:px-4">
        {{ day.label }}
        <span class="text-xs font-normal text-muted">{{ day.total }}</span>
        <span v-if="day.unread" class="text-xs font-normal text-muted">· {{ day.unread }} unread</span>
      </h2>
      <ul>
        <li v-for="row in day.rows" :key="row.key" class="border-b border-line">
          <div
              class="group relative grid grid-cols-[3.25rem_1.25rem_minmax(0,1fr)_1.75rem] items-stretch px-3 text-[13px] transition-colors hover:bg-hover sm:grid-cols-[3.25rem_1.25rem_5.5rem_4.75rem_minmax(0,1fr)_6.5rem_1.75rem] sm:px-4"
              :class="tint(row)"
          >
            <button
                type="button"
                class="absolute inset-0 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent-500/60 focus-visible:outline-none focus-visible:ring-inset"
                :aria-label="`${row.issue}: ${row.title}`"
                :aria-expanded="open.includes(row.key)"
                @click="toggle(row)"
            />
            <span class="self-center py-2 font-mono text-xs text-muted" :title="when(row.latest)">{{ time(row.latest) }}</span>
            <span class="relative flex items-center justify-center before:absolute before:inset-y-0 before:left-1/2 before:w-px before:bg-faint/40">
              <span class="relative size-2.5 rounded-full ring-2" :class="dot(row)" :data-state="row.waiting ? 'waiting' : row.unread ? 'unread' : 'read'" />
            </span>
            <span class="hidden self-center truncate py-2 pl-2 text-xs sm:block" :class="row.waiting ? 'text-violet-700 dark:text-violet-300' : 'text-muted'">{{ kind(row) }}</span>
            <NuxtLink
                :to="pathOf(row.project, row.issue)"
                class="relative z-10 hidden self-center truncate py-2 font-mono text-xs text-muted hover:text-fg hover:underline sm:block"
                @click="markRead(row.notices)"
            >{{ row.issue }}</NuxtLink>
            <span class="min-w-0 self-center truncate py-2 pl-2 sm:pl-0">
              <span :class="row.unread || row.waiting ? 'font-medium text-fg' : 'text-muted'">{{ row.title }}</span>
              <span class="ml-2 hidden text-xs text-muted lg:inline">{{ firstLine(row) }}</span>
            </span>
            <span class="hidden self-center truncate py-2 pl-2 text-right text-xs text-muted sm:block">{{ projectName(row.project) }}</span>
            <button
                v-if="row.notices.length === 1 && !row.notices[0]!.cleared"
                type="button"
                class="relative z-10 grid size-7 place-items-center self-center rounded-md text-faint opacity-0 group-hover:opacity-100 hover:bg-active hover:text-fg focus-visible:opacity-100"
                title="Clear"
                aria-label="Clear this notice"
                @click="clearOne(row.notices[0]!)"
            >
              <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </div>
          <div v-if="open.includes(row.key)" class="border-t border-line bg-panel py-3 pr-3 pl-[5.5rem] sm:pr-4">
            <NuxtLink :to="pathOf(row.project, row.issue)" class="mb-2 inline-block text-xs text-accent-700 hover:underline dark:text-accent-400">Open {{ row.issue }} →</NuxtLink>
            <div v-for="notice in row.notices" :key="noticeKey(notice)" class="group/notice relative border-t border-line py-2 first:border-t-0">
              <p v-if="row.notices.length > 1" class="mb-1 font-mono text-xs text-muted" :title="when(notice.created_at)">{{ time(notice.created_at) }}</p>
              <WaitingChip v-if="isWaiting(notice)" :asks="notice.asks!" :proposal="notice.proposal" class="mb-2" />
              <span v-else-if="notice.asks" class="mb-2 inline-block rounded-full px-2 py-0.5 text-[11px] text-muted ring-1 ring-line">{{ notice.answered ? 'Answered' : notice.proposal ? 'Cleared, still to decide' : 'Cleared' }}</span>
              <MarkdownView :source="notice.body" class="text-[14px] leading-6" />
              <UiButton v-if="row.notices.length > 1 && !notice.cleared" variant="ghost" size="xs" class="mt-1" @click="clearOne(notice)">Clear this one</UiButton>
            </div>
          </div>
        </li>
      </ul>
    </div>
    <div v-if="lists.inbox.more" class="flex justify-center py-6">
      <UiButton @click="load('inbox', true)">Show older</UiButton>
    </div>
    <div v-if="loaded && !shown.length" class="flex flex-col items-center gap-2 px-4 py-24 text-center">
      <p class="text-sm text-muted">No notifications.</p>
      <p class="text-xs text-faint">Agents' comments on issues land here and in the bell; their questions and proposals for you stay, marked in violet, until you answer or decide them on the issue, or clear them.</p>
    </div>
  </div>
</template>
