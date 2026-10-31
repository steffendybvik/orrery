<script setup lang="ts">
import type {Notice, NoticeChange} from '#shared/roadmap'
import {noticeKey} from '#shared/roadmap'
import type {NoticeRow} from '~/composables/useInbox'

// Notifications' reading pane: what happened on the line chosen in the list, newest first, its agents' comments in full with
// the status changes among them.
const props = defineProps<{row: NoticeRow, project: string}>()
defineEmits<{back: []}>()
const {changes, clear} = useInbox()
const {pathOf} = useIssueLink()

const moves = computed(() => rowChanges(props.row, changes.value))
const status = computed(() => moves.value.at(-1)?.after)
const merged = computed(() => latestMerged(props.row.notices))
type Entry = {key: string, at: string, notice?: Notice, change?: NoticeChange}
const entries = computed<Entry[]>(() => [
    ...props.row.notices.map(notice => ({key: `n${noticeKey(notice)}`, at: notice.created_at, notice})),
    ...moves.value.map(change => ({key: `c${change.id}`, at: change.created_at, change})),
].sort((a, b) => b.at.localeCompare(a.at)))
const clearable = computed(() => props.row.notices.filter(n => !n.cleared))
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'})
const when = (iso: string) => new Date(iso).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'})
</script>

<template>
  <article class="px-4 py-4 sm:px-6">
    <button type="button" class="mb-3 text-xs text-muted hover:text-fg lg:hidden" @click="$emit('back')">← Notifications</button>
    <p class="flex items-baseline gap-2 text-xs text-muted">
      <NuxtLink :to="pathOf(row.project, row.issue)" class="font-mono hover:text-fg hover:underline">{{ row.issue }}</NuxtLink>
      <span>{{ project }}</span>
    </p>
    <h2 class="mt-1 text-[17px]/snug font-semibold text-fg"><InlineText :text="row.title" /></h2>
    <div class="mt-2.5 flex flex-wrap items-center gap-1.5 text-xs">
      <span v-if="status" class="inline-flex items-center rounded-full px-2 py-0.5 ring-1 ring-line"><NoticeTransition :after="status" /></span>
      <span v-if="merged" class="rounded-full px-2 py-0.5 text-green-700 ring-1 ring-line dark:text-green-400">{{ merged }} merged</span>
      <NuxtLink :to="pathOf(row.project, row.issue)" class="px-1 text-accent-700 hover:underline dark:text-accent-400">Open {{ row.issue }} →</NuxtLink>
      <UiButton v-if="clearable.length > 1" variant="ghost" size="xs" class="ml-auto" @click="clear(clearable)">Clear these {{ clearable.length }}</UiButton>
    </div>
    <ol class="mt-4 border-l border-faint/40">
      <li v-for="entry in entries" :key="entry.key" class="relative py-2 pl-4">
        <template v-if="entry.notice">
          <span class="absolute top-[0.9rem] -left-[3.5px] size-1.5 rounded-full bg-faint" />
          <p class="mb-1 text-xs text-muted">
            <span class="font-mono" :title="when(entry.at)">{{ time(entry.at) }}</span>
            <span class="ml-2">{{ entry.notice.session_name ?? entry.notice.created_by }}</span>
          </p>
          <div class="group/notice rounded-xl border border-line bg-panel px-3 py-2.5">
            <WaitingChip v-if="isWaiting(entry.notice)" :asks="entry.notice.asks!" :proposal="entry.notice.proposal" class="mb-2" />
            <span v-else-if="entry.notice.asks" class="mb-2 inline-block rounded-full px-2 py-0.5 text-[11px] text-muted ring-1 ring-line">{{ entry.notice.answered ? 'Answered' : entry.notice.proposal ? 'Cleared, still to decide' : 'Cleared' }}</span>
            <MarkdownView :source="entry.notice.body" class="text-[14px] leading-6" />
            <UiButton v-if="!entry.notice.cleared" variant="ghost" size="xs" class="mt-1" @click="clear([entry.notice!])">Clear this one</UiButton>
          </div>
        </template>
        <p v-else-if="entry.change" class="flex flex-wrap items-center gap-x-2 text-xs text-muted">
          <span class="font-mono" :title="when(entry.at)">{{ time(entry.at) }}</span>
          <NoticeTransition :before="entry.change.before" :after="entry.change.after" />
          <span class="text-faint">{{ entry.change.session_name ?? entry.change.created_by }}</span>
        </p>
      </li>
    </ol>
  </article>
</template>
