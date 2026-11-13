<script setup lang="ts" generic="T extends string">
import {RadioGroup, RadioGroupOption} from '@headlessui/vue'
import {SEGMENTS, segment} from '~/utils/segments'

// A segmented choice (List | Board), with an optional key hint per option. Headless UI's RadioGroup makes it one
// stop for Tab, with ←→ moving the choice.
defineProps<{options: {value: T, label: string, hint?: string}[]}>()
const model = defineModel<T>({required: true})

// On a narrow screen the row scrolls sideways (ORR-1157), so the chosen option is kept in view.
const group = ref<{$el?: HTMLElement}>()
// Only the row itself scrolls, not the page round it.
function showChosen() {
    const row = group.value?.$el
    const chosen = row?.querySelector<HTMLElement>('[aria-checked="true"]')
    if (!row || !chosen || row.scrollWidth <= row.clientWidth) return
    const left = chosen.offsetLeft - row.offsetLeft
    if (left < row.scrollLeft) row.scrollLeft = left
    else if (left + chosen.offsetWidth > row.scrollLeft + row.clientWidth) row.scrollLeft = left + chosen.offsetWidth - row.clientWidth
}
onMounted(showChosen)
watch(model, () => nextTick(showChosen))
</script>

<template>
  <RadioGroup ref="group" v-model="model" :class="SEGMENTS">
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
