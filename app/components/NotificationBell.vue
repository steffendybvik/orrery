<script setup lang="ts">
// The bell in every page's header: agents' comments (answers to the owner, notes on their work), new
// ones counted. Opening it marks them read; a notice opens its issue.
const {notices, seenAt, unread, seen} = useInbox()
const {open: openIssue} = useIssueLink()
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
        :aria-label="unread ? `${unread} new comments from agents` : 'Comments from agents'"
        :title="unread ? `${unread} new` : 'Comments from agents'"
        @click="toggle"
    >
      <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
      <span v-if="unread" class="absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-accent-500 px-1 font-mono text-[9px] font-semibold text-white">{{ unread }}</span>
    </button>
    <div v-if="shown" class="glass absolute top-full right-0 z-40 mt-1.5 flex max-h-[70vh] w-[min(24rem,calc(100vw-2rem))] animate-fade-up flex-col overflow-hidden rounded-xl">
      <p class="label border-b border-line px-4 py-2.5">From agents</p>
      <ul class="overflow-y-auto py-1">
        <li v-for="notice in notices" :key="notice.id">
          <button type="button" class="flex w-full flex-col gap-1 px-4 py-2.5 text-left hover:bg-hover" @click="shown = false; openIssue(notice.project, notice.issue)">
            <span class="flex items-center gap-2 text-xs">
              <span v-if="notice.createdAt > seenAt" class="size-1.5 shrink-0 rounded-full bg-accent-500" />
              <PersonAvatar :name="notice.createdBy" :size="16" />
              <span class="text-fg">{{ notice.createdBy }}</span>
              <span class="text-faint">on</span>
              <span class="font-mono text-faint">{{ notice.issue }}</span>
              <span class="ml-auto shrink-0 text-faint">{{ ago(notice.createdAt) }}</span>
            </span>
            <span class="truncate text-[11px] text-faint">{{ notice.title }}</span>
            <span class="line-clamp-2 text-[13px] leading-snug text-muted">{{ notice.body }}</span>
          </button>
        </li>
        <li v-if="!notices.length" class="px-4 py-6 text-center text-xs text-faint">No comments from agents yet</li>
      </ul>
    </div>
  </div>
</template>
