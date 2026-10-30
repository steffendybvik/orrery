<script setup lang="ts">
// A group's tick (a status or chunk in the list, a column on the board): ticks every issue the group shows (`ids`),
// or unticks them once all are. A dash says only some are. Shown on the header's hover, and always once any is ticked.
const props = defineProps<{project: string, ids: string[], label: string}>()
const {selected, key, set} = useSelection()
const keys = computed(() => props.ids.map(id => key(props.project, id)))
const count = computed(() => keys.value.filter(k => selected.value.includes(k)).length)
const all = computed(() => count.value === keys.value.length)
</script>

<template>
  <button
      type="button"
      role="checkbox"
      :aria-checked="all ? true : count ? 'mixed' : false"
      :aria-label="`Select all in ${label}`"
      :title="all ? `Untick the ${keys.length} in ${label}` : `Tick the ${keys.length} in ${label}`"
      class="group/tick -m-1.5 shrink-0 p-1.5 outline-none"
      @click.stop="set(keys, !all)"
  >
    <span
        class="grid size-3.5 place-items-center rounded-[4px] ring-1 transition-opacity"
        :class="count ? 'bg-accent-500 text-zinc-950 ring-accent-500' : ['ring-faint/70 group-hover/tick:ring-fg', selected.length ? '' : 'opacity-0 group-hover:opacity-100 group-focus-visible/tick:opacity-100']"
    >
      <svg v-if="all" class="size-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10" /></svg>
      <svg v-else-if="count" class="size-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"><path d="M6 12h12" /></svg>
    </span>
  </button>
</template>
