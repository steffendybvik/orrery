<script setup lang="ts" generic="T extends string">
import type {ComponentPublicInstance} from 'vue'
import {Listbox, ListboxButton, ListboxOption, ListboxOptions} from '@headlessui/vue'

// A filter as a button with a menu of options to tick; empty means "any". Headless UI's Listbox does the keys
// (↑↓, ↵ or space ticks, typing jumps to an option, Esc closes), focus and outside-click.
const props = defineProps<{label: string, options: {value: T, label: string}[]}>()
const model = defineModel<T[]>({required: true})
const list = ref<ComponentPublicInstance | null>(null)

const summary = computed(() => {
    if (!model.value.length) return props.label
    if (model.value.length === 1) return props.options.find(o => o.value === model.value[0])?.label ?? props.label
    return `${props.label} · ${model.value.length}`
})

// Headless UI opens a multiple Listbox on what's ticked, but with nothing ticked lights nothing, so ↵ then space
// would tick nothing; then the first is lit (its own Home key).
function lightFirst() {
    requestAnimationFrame(() => {
        const options = list.value?.$el as HTMLElement | undefined
        if (options && !options.getAttribute('aria-activedescendant')) options.dispatchEvent(new KeyboardEvent('keydown', {key: 'Home'}))
    })
}
</script>

<template>
  <Listbox v-slot="{open}" v-model="model" as="div" class="relative" multiple>
    <ListboxButton
        class="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium ring-1 transition-colors"
        :class="model.length ? 'bg-accent-500/10 text-accent-700 ring-accent-500/30 dark:text-accent-300' : 'text-muted ring-line hover:bg-hover hover:text-fg'"
    >
      <slot name="icon" />
      {{ summary }}
      <svg class="size-3 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg>
    </ListboxButton>
    <div v-if="open" class="glass absolute top-full right-0 z-40 mt-1.5 w-48 animate-fade-up rounded-xl p-1" @vue:mounted="lightFirst">
      <ListboxOptions ref="list" class="focus:outline-none">
        <ListboxOption v-for="option in options" :key="option.value" v-slot="{active, selected}" :value="option.value" as="template">
          <li class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-fg" :class="active && 'bg-hover'">
            <span class="grid size-3.5 place-items-center rounded ring-1" :class="selected ? 'bg-accent-500 ring-accent-500' : 'ring-faint/60'">
              <svg v-if="selected" class="size-2.5 text-zinc-950" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10" /></svg>
            </span>
            <slot name="option" :value="option.value" />
            <span class="flex-1 truncate">{{ option.label }}</span>
          </li>
        </ListboxOption>
      </ListboxOptions>
      <button v-if="model.length" type="button" class="mt-1 w-full rounded-lg border-t border-line px-2 py-1.5 text-left text-xs text-muted hover:bg-hover" @click="model = []">Clear</button>
    </div>
  </Listbox>
</template>
