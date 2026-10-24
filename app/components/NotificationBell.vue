<script setup lang="ts">
// The bell in every page's header: agents' comments (answers to the owner, notes on their work), new
// ones counted. Opening it marks them read; a notice opens its issue. Read ones can be cleared all at
// once, any one with its ×. Those waiting on the owner (a decision, feedback) lead, and count until answered.
const {notices, seenAt, unread, waiting, read, seen, clear} = useInbox()
const ASKS = {decision: 'Needs your decision', feedback: 'Needs your feedback'}
const isWaiting = (n: {asks?: string, answered?: boolean}) => !!n.asks && !n.answered
const {open: openIssue} = useIssueLink()
const {who} = useOwner()
const shown = ref(false)
const root = ref<HTMLElement | null>(null)

function toggle() {
    shown.value = !shown.value
}
function close(event: PointerEvent) {
    if (!root.value?.contains(event.target as Node)) shown.value = false
}
watch(shown, now => {
    if (now) document.addEventListener('pointerdown', close)
    else {
        document.removeEventListener('pointerdown', close)
        seen()
    }
})
onBeforeUnmount(() => document.removeEventListener('pointerdown', close))
</script>

<template>
  <div ref="root" class="relative" @keydown.esc.stop="shown = false">
    <button
        type="button"
        class="relative grid size-7 place-items-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg"
        :aria-label="waiting.length ? `${waiting.length} waiting on you, ${unread} in all` : unread ? `${unread} new comments from agents` : 'Comments from agents'"
        :title="waiting.length ? `${waiting.length} waiting on you` : unread ? `${unread} new` : 'Comments from agents'"
        @click="toggle"
    >
      <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
      <span v-if="unread" class="absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-accent-500 px-1 font-mono text-[9px] font-semibold text-white">{{ unread }}</span>
    </button>
    <div v-if="shown" class="glass absolute top-full right-0 z-40 mt-1.5 flex max-h-[70vh] w-[min(24rem,calc(100vw-2rem))] animate-fade-up flex-col overflow-hidden rounded-xl">
      <div class="flex items-center border-b border-line px-4 py-1.5">
        <p class="label py-1">From agents</p>
        <button v-if="read" type="button" class="ml-auto rounded-md px-2 py-1 text-xs text-muted hover:bg-hover hover:text-fg" :title="`Clear the ${read} read`" @click="clear()">Clear read</button>
      </div>
      <ul class="overflow-y-auto py-1">
        <li v-if="waiting.length" class="label px-4 pt-2 pb-1 text-accent-600 dark:text-accent-400">Waiting on you</li>
        <li v-for="(notice, i) in notices" :key="notice.id" class="group relative" :class="i === waiting.length && waiting.length ? 'mt-1 border-t border-line pt-1' : ''">
          <button type="button" class="flex w-full flex-col gap-1 px-4 py-2.5 pr-10 text-left hover:bg-hover" @click="shown = false; openIssue(notice.project, notice.issue)">
            <span class="flex items-center gap-2 text-xs">
              <span v-if="notice.createdAt > seenAt || isWaiting(notice)" class="size-1.5 shrink-0 rounded-full bg-accent-500" />
              <PersonAvatar :name="notice.createdBy" :size="16" />
              <span class="text-fg">{{ who(notice.createdBy) }}</span>
              <span class="text-faint">on</span>
              <span class="font-mono text-faint">{{ notice.issue }}</span>
              <span class="ml-auto shrink-0 text-faint">{{ ago(notice.createdAt) }}</span>
            </span>
            <span class="flex min-w-0 items-center gap-2">
              <span v-if="isWaiting(notice)" class="shrink-0 rounded-full bg-accent-500/10 px-1.5 py-px text-[10px] font-medium text-accent-700 ring-1 ring-accent-500/30 dark:text-accent-300">{{ ASKS[notice.asks!] }}</span>
              <span class="truncate text-[11px] text-faint">{{ notice.title }}</span>
            </span>
            <span class="line-clamp-2 text-[13px] leading-snug text-muted">{{ notice.body }}</span>
          </button>
          <button
              type="button"
              class="absolute top-2 right-2 grid size-6 place-items-center rounded-md text-faint opacity-0 group-hover:opacity-100 hover:bg-active hover:text-fg focus-visible:opacity-100"
              title="Clear"
              aria-label="Clear this notice"
              @click="clear([notice.id])"
          >
            <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </li>
        <li v-if="!notices.length" class="px-4 py-6 text-center text-xs text-faint">No comments from agents yet</li>
      </ul>
    </div>
  </div>
</template>
