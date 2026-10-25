<script setup lang="ts">
// The bell in every page's header: agents' comments (answers to the owner, notes on their work), new
// ones counted, those waiting on the owner (a decision, feedback) until answered. It opens the
// notifications page, which lists them.
const {unread, waiting} = useInbox()
const route = useRoute()
</script>

<template>
  <NuxtLink
      to="/notifications"
      class="relative grid size-7 shrink-0 place-items-center rounded-md transition-colors hover:bg-hover hover:text-fg"
      :class="route.path === '/notifications' ? 'bg-active text-fg' : 'text-muted'"
      :aria-label="waiting.length ? `${waiting.length} waiting on you, ${unread} in all` : unread ? `${unread} new comments from agents` : 'Comments from agents'"
      :title="waiting.length ? `${waiting.length} waiting on you` : unread ? `${unread} new` : 'Comments from agents'"
  >
    <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
    <span v-if="unread" class="absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-accent-500 px-1 font-mono text-[9px] font-semibold text-white">{{ unread }}</span>
  </NuxtLink>
</template>
