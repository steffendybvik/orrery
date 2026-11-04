<script setup lang="ts">
import type {PullRisk, RiskLevel} from '#shared/roadmap'

// How risky a change is (ORR-879), as a chip: high red, medium amber, low quiet, so reviewing starts with what
// matters. Square-cornered, so it doesn't read as where the PR stands (PullStateChip). Its why is the hint, and who
// rated it: the session that opened the PR, or the owner, whose rating stands.
const props = defineProps<{risk: PullRisk}>()

const LEVELS: Record<RiskLevel, {label: string, tone: string}> = {
    high: {label: 'High risk', tone: 'text-rose-700 ring-rose-500/40 bg-rose-500/10 dark:text-rose-300'},
    medium: {label: 'Medium risk', tone: 'text-amber-800 ring-amber-500/40 bg-amber-500/10 dark:text-amber-300'},
    low: {label: 'Low risk', tone: 'text-muted ring-line'},
}
const hint = computed(() => `${props.risk.why} (rated by ${props.risk.by === 'owner' ? 'you' : 'the session that opened it'})`)
</script>

<template>
  <span class="flex h-5 shrink-0 items-center rounded px-1.5 text-[11px] font-medium ring-1" :class="LEVELS[risk.level].tone" :title="hint" data-test="risk">{{ LEVELS[risk.level].label }}</span>
</template>
