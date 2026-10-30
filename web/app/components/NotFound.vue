<script setup lang="ts">
// "Not found", the same on every page: what wasn't found (the slot), why that might be, and a way back. It
// names the tab too, so a missing page isn't titled like the page it was looking for. `heading`: h1 on a page whose
// header has none of its own, so it still has one for a screen reader (ORR-695).
withDefaults(defineProps<{
    reason?: string
    to: string
    back: string
    heading?: 'h1' | 'h2'
}>(), {reason: 'It may have moved or been deleted.', heading: 'h2'})
useHead({title: 'Not found · orrery'})
</script>

<template>
  <div class="grid place-items-center px-4 py-24 text-center text-sm text-muted">
    <div class="flex max-w-md flex-col items-center gap-2">
      <component :is="heading" class="text-[15px] font-medium text-fg">
        <slot />
      </component>
      <p class="text-xs text-faint">{{ reason }}</p>
      <UiButton :to="to" class="mt-2">{{ back }}</UiButton>
    </div>
  </div>
</template>
