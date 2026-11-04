<script setup lang="ts">
// A pull request on GitHub, as an icon button beside its number and title, which open its orrery page (ORR-893): the
// GitHub mark, opening it in a new tab.
defineProps<{number: number, url: string}>()
</script>

<template>
  <a
      :href="url"
      target="_blank"
      rel="noopener"
      class="grid size-6 shrink-0 place-items-center rounded-md text-faint transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-accent-500/60 focus-visible:outline-none"
      :title="`Open #${number} on GitHub, in a new tab`"
      :aria-label="`#${number} on GitHub`"
  >
    <svg class="size-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.58 9.58 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" /></svg>
  </a>
</template>
