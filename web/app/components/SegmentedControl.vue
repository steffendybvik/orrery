<script setup lang="ts" generic="T extends string">
// A segmented choice (List | Board), with an optional key hint per option.
defineProps<{options: {value: T, label: string, hint?: string}[]}>()
const model = defineModel<T>({required: true})
</script>

<template>
  <div class="flex gap-0.5 rounded-lg bg-well p-0.5 ring-1 ring-line">
    <button
        v-for="option in options"
        :key="option.value"
        type="button"
        class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
        :class="model === option.value ? 'bg-panel text-fg shadow-sm ring-1 ring-line dark:bg-white/12 dark:ring-0' : 'text-muted hover:text-fg'"
        :title="option.hint ? `${option.label} (${option.hint})` : option.label"
        @click="model = option.value"
    >
      <slot name="icon" :value="option.value" />
      {{ option.label }}
    </button>
  </div>
</template>
