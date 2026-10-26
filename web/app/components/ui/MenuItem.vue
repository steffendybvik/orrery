<script setup lang="ts">
// One line in a menu (docs/components.md), inside a `menu` panel: an icon in the slot before its text, then the
// text. `active` marks the current pick, `muted` a quieter line (‹ Back, None), `danger` the one that
// removes something.
defineProps<{active?: boolean, muted?: boolean, danger?: boolean}>()
</script>

<template>
  <button
      type="button"
      class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] disabled:opacity-50"
      :class="[danger ? 'text-rose-600 hover:bg-rose-500/10 dark:text-rose-400' : [muted ? 'text-muted' : 'text-fg', 'hover:bg-hover'], active && 'bg-active']"
  >
    <slot />
  </button>
</template>
