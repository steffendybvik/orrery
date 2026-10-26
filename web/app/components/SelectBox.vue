<script setup lang="ts">
// A row's or card's tick, for changing many issues at once: shown on hover, and always once any is ticked.
// Shift-click ticks the run from the last one.
const props = defineProps<{project: string, id: string}>()
const {selected, isSelected, toggle} = useSelection()
const ticked = computed(() => isSelected(props.project, props.id))
</script>

<template>
  <button
      type="button"
      role="checkbox"
      :aria-checked="ticked"
      :aria-label="`Select ${id}`"
      :title="`Select ${id} (x; shift-click for a run)`"
      class="grid size-3.5 shrink-0 place-items-center rounded-[4px] ring-1 transition-opacity"
      :class="ticked ? 'bg-accent-500 text-white ring-accent-500' : ['ring-faint/70 hover:ring-fg', selected.length ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100']"
      @click.stop="toggle(project, id, $event.shiftKey)"
  >
    <svg v-if="ticked" class="size-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10" /></svg>
  </button>
</template>
