<script setup lang="ts" generic="T extends string">
// A filter as a button with a menu of options to tick; empty means "any".
const props = defineProps<{label: string, options: {value: T, label: string}[]}>()
const model = defineModel<T[]>({required: true})
const open = ref(false)
const root = ref<HTMLElement | null>(null)

const summary = computed(() => {
    if (!model.value.length) return props.label
    if (model.value.length === 1) return props.options.find(o => o.value === model.value[0])?.label ?? props.label
    return `${props.label} · ${model.value.length}`
})

function toggle(value: T) {
    model.value = model.value.includes(value) ? model.value.filter(v => v !== value) : [...model.value, value]
}

function onOutside(event: PointerEvent) {
    if (!root.value?.contains(event.target as Node)) open.value = false
}
watch(open, isOpen => isOpen ? document.addEventListener('pointerdown', onOutside) : document.removeEventListener('pointerdown', onOutside))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutside))
</script>

<template>
  <div ref="root" class="relative" @keydown.esc.stop="open = false">
    <button
        type="button"
        class="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium ring-1 transition-colors"
        :class="model.length ? 'bg-accent-500/10 text-accent-600 ring-accent-500/30 dark:text-accent-300' : 'text-muted ring-line hover:bg-hover hover:text-fg'"
        :aria-expanded="open"
        @click="open = !open"
    >
      <slot name="icon" />
      {{ summary }}
      <svg class="size-3 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    <div v-if="open" class="glass absolute top-full right-0 z-40 mt-1.5 w-48 animate-fade-up rounded-xl p-1">
      <button
          v-for="option in options"
          :key="option.value"
          type="button"
          class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-fg hover:bg-hover"
          @click="toggle(option.value)"
      >
        <span class="grid size-3.5 place-items-center rounded ring-1" :class="model.includes(option.value) ? 'bg-accent-500 ring-accent-500' : 'ring-faint/60'">
          <svg v-if="model.includes(option.value)" class="size-2.5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10" /></svg>
        </span>
        <slot name="option" :value="option.value" />
        <span class="flex-1 truncate">{{ option.label }}</span>
      </button>
      <button v-if="model.length" type="button" class="mt-1 w-full rounded-lg border-t border-line px-2 py-1.5 text-left text-xs text-muted hover:bg-hover" @click="model = []">Clear</button>
    </div>
  </div>
</template>
