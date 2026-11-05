<script setup lang="ts">
// A page or panel with nothing to show yet (docs/components.md): the spinner in the middle of it. It comes in a moment
// late, so an answer that's nearly there doesn't flash it. When what it waits on has failed it says so instead, with
// the reason and a Try again (ORR-854): `failed` for the page's own read, named by `what`, which emits `retry`; or else
// the projects' first read, which every page waits on, and which it reads again itself.
const props = withDefaults(defineProps<{failed?: string, what?: string}>(), {failed: '', what: 'this page'})
const emit = defineEmits<{retry: []}>()
const roadmaps = useRoadmaps()
const own = computed(() => !!props.failed)
const message = computed(() => props.failed || roadmaps.failed.value)
const retry = () => own.value ? emit('retry') : roadmaps.retries.value++
</script>

<template>
  <div v-if="message" class="grid place-items-center px-4 py-24 text-center" role="alert">
    <div class="flex max-w-md flex-col items-center gap-2">
      <p class="flex items-center gap-1.5 text-[15px] font-medium text-fg">
        <svg class="size-4 shrink-0 text-rose-700 dark:text-rose-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" /><path d="M12 9v4M12 17h.01" /></svg>
        Couldn't load {{ own ? what : 'the projects' }}
      </p>
      <p class="text-xs text-muted">{{ message }}</p>
      <UiButton class="mt-2" @click="retry">Try again</UiButton>
    </div>
  </div>
  <div v-else class="grid animate-appear place-items-center px-4 py-24 text-lg text-faint" role="status" aria-label="Loading">
    <UiSpinner />
  </div>
</template>
