<script setup lang="ts">
// A row's or card's tick, for changing many issues at once: shown on hover, and always once any is ticked.
// Shift-click ticks the run from the last one; pressing it and dragging over other rows ticks them too (or unticks,
// when the press unticked it). The keyboard's Enter or Space ticks it with a plain click. It takes clicks a few px either side of the box, and in a row
// (`row`) the row's whole height (its padding, taken back by as much margin, so it lays out at the box's size):
// a click that just misses the box ticks instead of opening the issue.
const props = defineProps<{project: string, id: string, row?: boolean}>()
const {selected, isSelected, toggle, drag} = useSelection()
const ticked = computed(() => isSelected(props.project, props.id))
</script>

<template>
  <button
      type="button"
      role="checkbox"
      :aria-checked="ticked"
      :aria-label="`Select ${id}`"
      :title="`Select ${id} (x; drag over others, or shift-click, for a run)`"
      class="group/tick -mx-1.5 shrink-0 px-1.5 outline-none"
      :class="row ? '-my-[15px] py-[15px]' : '-my-1.5 py-1.5'"
      @pointerdown="drag($event, project, id)"
      @click.stop="toggle(project, id, $event.shiftKey)"
  >
    <span
        class="grid size-3.5 place-items-center rounded-[4px] ring-1 transition-opacity"
        :class="ticked ? 'bg-accent-fill text-on-accent ring-accent-fill' : ['ring-faint/70 group-hover/tick:ring-fg', selected.length ? '' : 'opacity-0 group-hover:opacity-100 group-focus-visible/tick:opacity-100']"
    >
      <svg v-if="ticked" class="size-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10" /></svg>
    </span>
  </button>
</template>
