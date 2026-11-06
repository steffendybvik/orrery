<script setup lang="ts" generic="T extends string">
import {RadioGroup, RadioGroupOption} from '@headlessui/vue'
import {SEGMENTS, segment} from '~/utils/segments'

// A segmented choice (List | Board), with an optional key hint per option. Headless UI's RadioGroup makes it one
// stop for Tab, with ←→ moving the choice.
defineProps<{options: {value: T, label: string, hint?: string}[]}>()
const model = defineModel<T>({required: true})
</script>

<template>
  <RadioGroup v-model="model" :class="SEGMENTS">
    <RadioGroupOption
        v-for="option in options"
        :key="option.value"
        v-slot="{checked}"
        :value="option.value"
        as="template"
    >
      <div
          :class="segment(checked)"
          :title="option.hint ? `${option.label} (${option.hint})` : option.label"
      >
        <slot name="icon" :value="option.value" />
        {{ option.label }}
      </div>
    </RadioGroupOption>
  </RadioGroup>
</template>
