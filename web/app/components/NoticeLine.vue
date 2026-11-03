<script setup lang="ts">
import type {NoticeRow} from '~/composables/useInbox'

// A line in Notifications' list: an issue's notices from one day, or what waits on the owner on it. What it says is what
// happened (its status, a pull request merged) or, for a question, the question; choosing it opens its history beside the
// list. A filled dot is unread, a hollow one read, violet waits on the owner. Its × clears the whole line.
const props = defineProps<{row: NoticeRow, selected: boolean, project?: string}>()
defineEmits<{select: [], clear: []}>()
const {changes, lists} = useInbox()

const change = computed(() => netChange(rowChanges(props.row, changes.value)))
const lead = computed(() => props.row.notices[0])
const text = computed(() => !props.row.waiting || lead.value?.proposal ? props.row.title : questionOf(lead.value?.body ?? '') || props.row.title)
/** A question overtaken: a pull request on its issue merged since it was asked. */
const mergedSince = computed(() => {
    if (!props.row.waiting) return null
    return latestMerged(lists.value.inbox.items.filter(n => n.project === props.row.project && n.issue === props.row.issue && n.created_at > props.row.latest))
})
const merged = computed(() => props.row.waiting ? null : latestMerged(props.row.notices))
const more = computed(() => props.row.waiting ? props.row.notices.length - 1 : 0)
const time = computed(() => new Date(props.row.latest).toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'}))
const when = computed(() => new Date(props.row.latest).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'}))
const state = computed(() => props.row.waiting ? 'waiting' : props.row.unread ? 'unread' : 'read')
const clearable = computed(() => props.row.notices.filter(n => !n.cleared).length)
const clearLabel = computed(() => clearable.value === 1 ? 'Clear this notice' : `Clear these ${clearable.value}`)
</script>

<template>
  <li class="border-b border-line">
    <div
        class="group relative grid grid-cols-[1.25rem_minmax(0,1fr)_auto] gap-x-2 pr-10 pl-2 transition-colors hover:bg-hover"
        :class="[
          row.waiting ? 'bg-violet-500/10' : row.unread ? 'bg-accent-500/10' : '',
          selected ? 'bg-active shadow-[inset_2px_0_0_var(--color-accent-fill)]' : '',
        ]"
    >
      <button
          type="button"
          data-nav
          class="absolute inset-0 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent-500/60 focus-visible:outline-none focus-visible:ring-inset"
          :aria-label="`${row.issue}: ${row.title}`"
          :aria-current="selected ? 'true' : undefined"
          @click="$emit('select')"
      />
      <span class="relative flex items-center justify-center before:absolute before:inset-y-0 before:left-1/2 before:w-px before:bg-faint/40">
        <span
            class="relative size-2.5 rounded-full ring-2"
            :class="row.waiting ? 'bg-violet-500 ring-violet-500' : row.unread ? 'bg-accent-fill ring-accent-fill' : 'bg-canvas ring-faint'"
            :data-state="state"
        />
      </span>
      <div class="min-w-0 py-2">
        <p class="truncate text-[13px]" :class="row.unread || row.waiting ? 'font-medium text-fg' : 'text-muted'"><InlineText :text="text" /></p>
        <p class="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden text-xs whitespace-nowrap text-muted">
          <template v-if="row.waiting">
            <span v-if="mergedSince" class="text-green-700 dark:text-green-400">{{ mergedSince }} merged since</span>
            <span v-if="more">+{{ more }} more</span>
            <span v-if="lead?.proposal">Proposal</span>
            <span v-else-if="!mergedSince && !more" class="truncate"><InlineText :text="row.title" /></span>
          </template>
          <template v-else>
            <NoticeTransition v-if="change" v-bind="change" />
            <span v-if="change && merged" class="text-faint">·</span>
            <span v-if="merged" class="text-green-700 dark:text-green-400">{{ merged }} merged</span>
            <span v-if="!change && !merged" class="truncate">{{ plainLine(lead?.body ?? '') }}</span>
          </template>
          <span v-if="project" class="ml-auto shrink-0 pl-2 text-faint">{{ project }}</span>
        </p>
      </div>
      <div class="flex flex-col items-end py-2 font-mono text-xs text-muted">
        <span :title="when">{{ time }}</span>
        <span class="mt-0.5">{{ row.issue }}</span>
      </div>
      <button
          v-if="clearable"
          type="button"
          class="absolute top-1/2 right-2 z-10 grid size-6 -translate-y-1/2 place-items-center rounded-md text-faint hover:bg-active hover:text-fg"
          :title="clearLabel"
          :aria-label="clearLabel"
          @click="$emit('clear')"
      >
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    </div>
  </li>
</template>
