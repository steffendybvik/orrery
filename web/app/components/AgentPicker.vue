<script setup lang="ts">
import {AGENT_CHOICES, type AgentChoice} from '#shared/roadmap'

// Which AI agent the owner runs (ORR-1075), on App settings and Getting started: Claude Code unless they pick another,
// and what's shown for connecting follows it. Saved as it's picked.
const {settings, save} = useAppSettings()
const options = (Object.keys(AGENT_CHOICES) as AgentChoice[]).map(value => ({value, label: AGENT_CHOICES[value]}))
const failed = ref('')
const agent = computed<AgentChoice>({
    get: () => settings.value.agent,
    set: async next => {
        failed.value = ''
        try {
            await save({agent: next})
        } catch (error) {
            failed.value = errorMessage(error)
        }
    },
})
</script>

<template>
  <div class="flex flex-col gap-1.5" data-agent-picker>
    <SegmentedControl v-model="agent" :options="options" aria-label="The AI agent you run" class="self-start" />
    <p v-if="failed" class="text-xs text-rose-700 dark:text-rose-400" role="alert">{{ failed }}</p>
  </div>
</template>
