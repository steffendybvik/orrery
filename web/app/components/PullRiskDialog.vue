<script setup lang="ts">
import type {PullRisk, RiskLevel} from '#shared/roadmap'
import {RISK_LEVELS} from '#shared/roadmap'

// Rating a PR's risk yourself, from an issue's page (ORR-879): high, medium or low with a line on why, or Clear to take
// the rating away. The levels are a SegmentedControl, the app's one look for a set of choices (ORR-992). Yours stands: a session's later rating doesn't replace it. `pull` is the PR on its row, null when shut.
const props = defineProps<{project: string, issue: string, pull: {number: number, url: string, risk?: PullRisk} | null}>()
const emit = defineEmits<{close: [], rated: []}>()

const level = ref<RiskLevel>('medium')
const why = ref('')
const busy = ref(false)
const failed = ref('')
watch(() => props.pull, pull => {
    level.value = pull?.risk?.level ?? 'medium'
    why.value = pull?.risk?.why ?? ''
    failed.value = ''
})
const LABELS: Record<RiskLevel, string> = {high: 'High', medium: 'Medium', low: 'Low'}
const options = RISK_LEVELS.map(value => ({value, label: LABELS[value]}))

/** The PR's repo and number, from its link: one from a repo the project has left is rated the same way. */
const path = computed(() => {
    const found = props.pull && /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(props.pull.url)
    return found ? `/projects/${encodeURIComponent(props.project)}/issues/${encodeURIComponent(props.issue)}/pulls/${found[1]}/${found[2]}/${found[3]}/risk` : null
})

async function save(rating: {level: RiskLevel, why: string} | {level: null}) {
    if (!path.value || busy.value) return
    busy.value = true
    failed.value = ''
    try {
        await apiFetch(path.value, {method: 'PUT', body: rating})
        emit('rated')
        emit('close')
    } catch (error) {
        failed.value = errorMessage(error, 'save')
    } finally {
        busy.value = false
    }
}
const submit = () => why.value.trim() && save({level: level.value, why: why.value.trim()})
</script>

<template>
  <UiDialog :open="pull" :label="`Rate the risk of #${pull?.number}`" width="md" @close="emit('close')" @submit="submit">
    <h2 class="text-base font-semibold text-fg">Rate the risk of #{{ pull?.number }}</h2>
    <p class="text-xs text-muted">Your rating stands: a session's later one doesn't replace it.</p>
    <SegmentedControl v-model="level" :options="options" class="self-start" aria-label="Risk" />
    <input v-model="why" aria-label="Why" maxlength="300" placeholder="Why, e.g. bug fix in signal routing" class="rounded-lg bg-well px-3 py-2 text-sm text-fg ring-1 ring-line placeholder:text-faint focus:ring-accent-500/50 focus:outline-none">
    <p v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">{{ failed }}</p>
    <div class="flex items-center gap-2">
      <UiButton v-if="pull?.risk" variant="danger-ghost" size="sm" :disabled="busy" @click="save({level: null})">Clear</UiButton>
      <UiButton type="submit" variant="primary" size="md" class="ml-auto" :disabled="busy || !why.trim()"><UiBusy :busy="busy" label="Saving…">Save</UiBusy></UiButton>
    </div>
  </UiDialog>
</template>
