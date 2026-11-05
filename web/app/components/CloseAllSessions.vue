<script setup lang="ts">
import type {Session} from '#shared/roadmap'
import {closable} from '#shared/roadmap'

// Close all, in the Sessions page's toolbar (ORR-970): stops every session the page lists that a Stop can reach, the
// same way each card's Stop does: one orrery started through its launch, one opened in a terminal through its channel.
// The owner's chat stays, as it's their conversation, not work. It asks first, saying how many and how many are in the
// middle of something, as that goes with them; a session's own Stop doesn't (ORR-971), this stops many at once.
const props = defineProps<{sessions: Session[]}>()
const sure = ref(false)
const busy = ref(false)
const failed = ref('')
const targets = computed(() => props.sessions.filter(closable))
const working = computed(() => targets.value.filter(s => s.state === 'working' || s.state === 'waiting').length)
const plural = (n: number) => `${n} ${n === 1 ? 'session' : 'sessions'}`

const stopOne = (s: Session) => apiFetch(s.started
    ? `/projects/${encodeURIComponent(s.project)}/launches/${s.started.launch}/stop`
    : `/projects/${encodeURIComponent(s.project)}/sessions/${encodeURIComponent(s.id)}/stop`, {method: 'POST', body: {}})

async function closeAll() {
    busy.value = true
    failed.value = ''
    const results = await Promise.allSettled(targets.value.map(stopOne))
    const missed = results.filter(r => r.status === 'rejected').length
    if (missed) failed.value = `${plural(missed)} didn't stop`
    busy.value = false
    sure.value = false
}
</script>

<template>
  <span v-if="targets.length" class="flex shrink-0 items-center gap-1.5 text-xs">
    <span v-if="failed" class="text-rose-700 dark:text-rose-400">{{ failed }}</span>
    <template v-if="sure">
      <span class="text-muted">Close {{ plural(targets.length) }}<template v-if="working">, {{ working }} working</template>?</span>
      <UiButton variant="danger-outline" class="shrink-0" :disabled="busy" @click="closeAll"><UiBusy :busy="busy" label="Closing…">Close all</UiBusy></UiButton>
      <UiButton class="shrink-0" :disabled="busy" @click="sure = false">Cancel</UiButton>
    </template>
    <UiButton v-else class="shrink-0" :title="`Stop all ${plural(targets.length)} listed here; the chat stays`" @click="sure = true">Close all</UiButton>
  </span>
</template>
