<script setup lang="ts">
// Labels as a button with a menu: tick the project's labels, or type one to find it or make a new one.
const props = defineProps<{labels: string[]}>()
const model = defineModel<string[]>({required: true})
const open = ref(false)
const query = ref('')
const root = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)

const typed = computed(() => query.value.trim())
const shown = computed(() => {
    const all = [...new Set([...props.labels, ...model.value])].sort((a, b) => a.localeCompare(b))
    return typed.value ? all.filter(l => l.toLowerCase().includes(typed.value.toLowerCase())) : all
})
const isNew = computed(() => typed.value && !shown.value.some(l => l.toLowerCase() === typed.value.toLowerCase()))

function toggle(label: string) {
    model.value = model.value.includes(label) ? model.value.filter(l => l !== label) : [...model.value, label]
}

function enter() {
    if (isNew.value) toggle(typed.value)
    else if (shown.value[0]) toggle(shown.value[0])
    query.value = ''
}

useDismiss(root, () => open.value, () => open.value = false)
watch(open, isOpen => {
    query.value = ''
    if (isOpen) nextTick(() => input.value?.focus())
})
</script>

<template>
  <div ref="root" class="relative" @keydown.esc.stop="open = false">
    <button
        type="button"
        class="flex h-8 max-w-72 items-center gap-1.5 rounded-lg bg-well px-2.5 text-[13px] ring-1 ring-line hover:text-fg focus:ring-accent-500/50 focus:outline-none"
        :class="model.length ? 'text-fg' : 'text-muted'"
        :aria-expanded="open"
        aria-label="Labels"
        @click="open = !open"
    >
      <template v-if="model.length">
        <LabelChip v-for="label in model.slice(0, 2)" :key="label" :label="label" />
        <span v-if="model.length > 2" class="text-xs text-faint">+{{ model.length - 2 }}</span>
      </template>
      <span v-else>Labels</span>
    </button>
    <div v-if="open" class="glass absolute bottom-full left-0 z-40 mb-1.5 w-56 animate-fade-up rounded-xl p-1">
      <input
          ref="input"
          v-model="query"
          placeholder="Find or add a label…"
          aria-label="Find or add a label"
          class="mb-1 h-7 w-full rounded-lg bg-transparent px-2 text-[13px] text-fg placeholder:text-faint focus:outline-none"
          @keydown.enter.prevent.stop="enter"
      >
      <div class="max-h-56 overflow-y-auto border-t border-line pt-1">
        <button
            v-for="label in shown"
            :key="label"
            type="button"
            class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-fg hover:bg-hover"
            @click="toggle(label)"
        >
          <span class="grid size-3.5 place-items-center rounded ring-1" :class="model.includes(label) ? 'bg-accent-500 ring-accent-500' : 'ring-faint/60'">
            <svg v-if="model.includes(label)" class="size-2.5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10" /></svg>
          </span>
          <LabelChip :label="label" />
        </button>
        <button v-if="isNew" type="button" class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-muted hover:bg-hover" @click="enter">
          <span class="grid size-3.5 place-items-center text-faint">+</span>
          Add “<span class="truncate text-fg">{{ typed }}</span>”
        </button>
        <p v-if="!shown.length && !isNew" class="px-2 py-1.5 text-xs text-faint">No labels yet. Type one to add it.</p>
      </div>
    </div>
  </div>
</template>
