<script setup lang="ts">
import type {Issue} from '#shared/roadmap'

// Who holds an issue, and for how long, on a list or a board (ORR-657). With one person it shows nothing.
const props = defineProps<{issue: Issue}>()
const {shared, nameOf} = usePeople()
const said = computed(() => props.issue.claimed_by && `Held by ${nameOf(props.issue.claimed_by)}${props.issue.claimed_at ? ` for ${ago(props.issue.claimed_at)}` : ''}`)
</script>

<template>
  <span v-if="shared && said" class="shrink-0 text-[11px] text-muted" :title="said" :aria-label="said">
    {{ nameOf(issue.claimed_by!) }}<template v-if="issue.claimed_at"> · {{ ago(issue.claimed_at) }}</template>
  </span>
</template>
