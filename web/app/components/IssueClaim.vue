<script setup lang="ts">
import type {Issue, Session} from '#shared/roadmap'

// Who holds an issue, and claiming, letting go and taking over, beside its assignee (ORR-657). With one person it shows
// nothing. Each shows in the activity, and the server says who may.
const props = defineProps<{issue: Issue, project: string, worker?: Session}>()
const {shared, me, owner, nameOf} = usePeople()
const busy = ref(false)
const failed = ref('')
const holds = computed(() => !!props.issue.claimed_by && props.issue.claimed_by === me.value)
const isOwner = computed(() => me.value === owner.value)
const assigned = computed(() => props.issue.assignee?.toLowerCase() ?? '')
const mayClaim = computed(() => !holds.value && !props.issue.claimed_by && (isOwner.value || !assigned.value || assigned.value === me.value))
const mayTake = computed(() => isOwner.value && !holds.value && !!props.issue.claimed_by)
async function act(method: 'POST' | 'DELETE') {
    busy.value = true
    failed.value = ''
    try {
        await apiFetch(`/projects/${encodeURIComponent(props.project)}/issues/${encodeURIComponent(props.issue.id)}/claim`, {method})
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        busy.value = false
    }
}
</script>

<template>
  <div v-if="shared" class="flex min-w-0 flex-col gap-1 py-1 text-xs text-muted">
    <p v-if="issue.claimed_by">
      Held by <span class="text-fg">{{ nameOf(issue.claimed_by) }}</span><template v-if="issue.claimed_at"> for {{ ago(issue.claimed_at) }}</template><template v-if="worker">, {{ worker.name }} on it</template>
    </p>
    <p v-else>Nobody's taken it up</p>
    <div class="flex flex-wrap gap-1.5">
      <UiButton v-if="mayClaim" size="xs" :disabled="busy" @click="act('POST')">Claim</UiButton>
      <UiButton v-if="mayTake" size="xs" :disabled="busy" @click="act('POST')">Take over</UiButton>
      <UiButton v-if="issue.claimed_by && (holds || isOwner)" size="xs" :disabled="busy" @click="act('DELETE')">Let go</UiButton>
    </div>
    <p v-if="failed" class="text-rose-600 dark:text-rose-400">{{ failed }}</p>
  </div>
</template>
