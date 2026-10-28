<script setup lang="ts">
import {TINTS} from '#shared/roadmap'

// Picks an icon, any Heroicon found by name, and its colour (a tint, a custom `#rrggbb`, or none: the text's).
// Each pick is emitted as the change to save: `{icon}` or `{color}`.
const props = defineProps<{icon: string | null, color: string | null, label?: string}>()
const emit = defineEmits<{change: [change: {icon?: string | null, color?: string | null}]}>()
const search = ref('')
const custom = ref('#3b82f6')
watch(() => props.color, now => {
    if (now?.startsWith('#')) custom.value = now
}, {immediate: true})
const shown = computed(() => {
    const words = search.value.trim().toLowerCase().split(/[\s-]+/).filter(Boolean)
    return HEROICONS.filter(name => words.every(word => name.includes(word)))
})
</script>

<template>
  <div class="flex flex-col gap-2 rounded-xl border border-line p-3">
    <div class="flex flex-wrap items-center gap-1.5" role="group" :aria-label="`${label ?? 'Icon'} colour`">
      <span class="mr-1 text-xs text-muted">Colour</span>
      <button
          type="button"
          class="flex h-7 items-center rounded-lg px-2.5 text-xs ring-1 transition-colors"
          :class="!color ? 'bg-active text-fg ring-faint/60' : 'text-muted ring-line hover:bg-hover'"
          :aria-pressed="!color"
          title="Follows the text"
          @click="emit('change', {color: null})"
      >None</button>
      <button
          v-for="(value, tint) in TINTS"
          :key="tint"
          type="button"
          class="grid size-7 place-items-center rounded-lg ring-1 transition-colors"
          :class="color === tint ? 'bg-active ring-faint/60' : 'ring-line hover:bg-hover'"
          :title="tint"
          :aria-label="tint"
          :aria-pressed="color === tint"
          @click="emit('change', {color: tint})"
      >
        <span class="size-3.5 rounded-full ring-1 ring-black/10" :style="{background: value}" />
      </button>
      <label
          class="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs ring-1"
          :class="color?.startsWith('#') ? 'bg-active text-fg ring-faint/60' : 'text-muted ring-line'"
      >
        <input v-model="custom" type="color" :aria-label="`Custom ${(label ?? 'icon').toLowerCase()} colour`" class="size-4 rounded border-0 bg-transparent p-0" @change="emit('change', {color: custom})">
        Custom
      </label>
    </div>
    <input v-model="search" type="search" placeholder="Find an icon: cart, lock, bolt…" aria-label="Find an icon" spellcheck="false" class="h-8 field">
    <div class="grid max-h-56 grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] gap-1 overflow-y-auto">
      <button
          v-for="name in shown"
          :key="name"
          type="button"
          class="grid h-9 place-items-center rounded-lg transition-colors"
          :class="icon === name ? 'bg-accent-500/15 text-accent-600 ring-1 ring-accent-500/40 dark:text-accent-300' : 'text-muted hover:bg-hover hover:text-fg'"
          :title="name"
          :aria-label="name"
          :aria-pressed="icon === name"
          @click="emit('change', {icon: name})"
      >
        <ProjectIcon :icon="name" :color="icon === name ? color : null" class="size-4" />
      </button>
    </div>
    <p v-if="!shown.length" class="px-1 py-4 text-center text-xs text-faint">No icon called “{{ search }}”.</p>
    <slot />
  </div>
</template>
