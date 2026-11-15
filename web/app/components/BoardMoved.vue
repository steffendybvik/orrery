<script setup lang="ts">
// A board marked as moved to another orrery (ORR-1225): it only reads here, so the board says where it went, and the
// owner can undo the mark from its Settings.
defineProps<{project: {id: string, name: string, moved_to?: string}}>()
</script>

<template>
  <div v-if="project.moved_to" role="status" class="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-[13px] text-amber-800 sm:px-8 dark:text-amber-300">
    <span><span class="font-medium">{{ project.name }} moved</span> to <a :href="project.moved_to" target="_blank" rel="noopener" class="underline underline-offset-2">{{ project.moved_to }}</a>. It only reads here: make changes there.</span>
    <NuxtLink :to="`/p/${encodeURIComponent(project.id)}/settings#moved`" class="ml-auto text-xs underline underline-offset-2">Settings</NuxtLink>
  </div>
</template>
