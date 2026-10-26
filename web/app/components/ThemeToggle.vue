<script setup lang="ts">
// One button, at the right of every page's header: light ⇄ dark. Until one is picked, the page
// follows the system, and keeps following it while it changes.
const {dark, toggle, apply} = useTheme()

let media: MediaQueryList | null = null
onMounted(() => {
    media = matchMedia('(prefers-color-scheme: light)')
    media.addEventListener('change', apply)
})
onBeforeUnmount(() => media?.removeEventListener('change', apply))
</script>

<template>
  <UiButton
      variant="ghost"
      square
      class="shrink-0"
      :title="dark ? 'Switch to light' : 'Switch to dark'"
      :aria-label="dark ? 'Switch to light' : 'Switch to dark'"
      @click="toggle"
  >
    <svg v-if="dark" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
    <svg v-else class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" /></svg>
  </UiButton>
</template>
