<script setup lang="ts">
import type {Section} from '~/utils/roadmap'

// A project's page, or `schedules` (its schedules, on the Settings page).
defineProps<{section: Section | 'schedules'}>()
</script>

<template>
  <svg class="size-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <template v-if="section === 'issues'"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" /></template>
    <template v-else-if="section === 'roadmap'"><path d="M4 6h9M4 12h13M4 18h6" /><circle cx="17" cy="6" r="1.6" fill="currentColor" stroke="none" /><circle cx="20" cy="18" r="1.6" fill="currentColor" stroke="none" /></template>
    <template v-else-if="section === 'schedules'"><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 2.5M9 2h6" /></template>
    <template v-else-if="section === 'settings'"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" /></template>
    <template v-else><path d="M6 3h8l4 4v14H6Z" /><path d="M14 3v4h4" /></template>
  </svg>
</template>
