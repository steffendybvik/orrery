<script setup lang="ts" generic="T extends string">
import {RadioGroup, RadioGroupOption} from '@headlessui/vue'

// A segmented choice (List | Board), with an optional key hint per option. Headless UI's RadioGroup makes it one
// stop for Tab, with ←→ moving the choice.
defineProps<{options: {value: T, label: string, hint?: string}[]}>()
const model = defineModel<T>({required: true})
</script>

<template>
  <RadioGroup v-model="model" class="flex gap-0.5 rounded-lg bg-well p-0.5 ring-1 ring-line">
    <RadioGroupOption
        v-for="option in options"
        :key="option.value"
        v-slot="{checked}"
        :value="option.value"
        as="template"
    >
      <div
          class="flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/50"
          :class="checked ? 'bg-panel text-fg shadow-sm ring-1 ring-line dark:bg-white/12 dark:ring-0' : 'text-muted hover:text-fg'"
          :title="option.hint ? `${option.label} (${option.hint})` : option.label"
      >
        <slot name="icon" :value="option.value" />
        {{ option.label }}
      </div>
    </RadioGroupOption>
  </RadioGroup>
</template>
