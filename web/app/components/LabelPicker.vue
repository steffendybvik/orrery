<script setup lang="ts">
// A new issue's labels as a field with a menu above it: tick the project's labels, or type one to find it or make a
// new one. It's a PropertyPicker (multiple, creatable), showing the first two picked.
const props = defineProps<{labels: string[]}>()
const model = defineModel<string[]>({required: true})

const options = computed(() => [...new Set([...props.labels, ...model.value])]
    .sort((a, b) => a.localeCompare(b))
    .map(l => ({value: l, label: l})))
</script>

<template>
  <PropertyPicker v-model="model" :options="options" label="Labels" placeholder="Find or add a label…" multiple creatable field up>
    <template v-if="model.length">
      <LabelChip v-for="label in model.slice(0, 2)" :key="label" :label="label" />
      <span v-if="model.length > 2" class="text-xs text-faint">+{{ model.length - 2 }}</span>
    </template>
    <span v-else class="text-muted">Labels</span>
    <template #option="{option}">
      <LabelChip :label="option.value" />
    </template>
  </PropertyPicker>
</template>
