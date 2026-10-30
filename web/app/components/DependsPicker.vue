<script setup lang="ts">
import {linkRef} from '#shared/roadmap'

// Issues linked to one (ORR-601), picked from every project's, by id or title: a property's button on the issue's page,
// for what blocks it or, with `label`, what it blocks (ORR-680), or with `field` a field in the New issue dialog. Each is
// its `linkRef` from `here`; `self` isn't offered.
const props = withDefaults(defineProps<{here: string, self?: string, field?: boolean, disabled?: boolean, label?: string}>(), {label: 'Blocked by'})
const model = defineModel<string[]>({required: true})
const {projects} = useRoadmaps()
// One linked that the page doesn't have (closed, in a project read without them) stays, to take off.
const options = computed(() => {
    const all = linkOptions(projects.value, props.here, props.self)
    return [...all, ...model.value.filter(ref => !all.some(o => o.value === ref)).map(ref => ({value: ref, label: ref}))]
})
// Worked out once as it's asked for every row, and a board can have hundreds (ORR-680).
const columns = computed(() => new Map(projects.value.flatMap(p => allIssues(p).map(({issue}) => [linkRef(props.here, p.id, issue.id), issue.column]))))
const columnOf = (ref: string) => columns.value.get(ref)
</script>

<template>
  <PropertyPicker v-model="model" :options="options" :label="label" placeholder="Find an issue by id or title…" multiple wide :field="field" :disabled="disabled">
    <template v-if="field">
      <svg class="size-3.5 shrink-0 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>
      <span class="truncate" :class="!model.length && 'text-faint'">{{ model.length ? model.join(', ') : label }}</span>
    </template>
    <span v-else class="text-faint">{{ model.length ? 'Edit' : 'Add' }}</span>
    <template #option="{option}">
      <StatusIcon v-if="columnOf(option.value)" :column="columnOf(option.value)!" />
      <span class="min-w-0 flex-1 truncate" :title="option.label">{{ option.label }}</span>
    </template>
  </PropertyPicker>
</template>
