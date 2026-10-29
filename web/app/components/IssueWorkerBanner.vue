<script setup lang="ts">
import type {Session} from '#shared/roadmap'
import {TERMINALS} from '#shared/roadmap'

// Says which session is working the issue, at the top of its page (`useIssueWorker`): its dot, pulsing while it works,
// its name linking to it on the Sessions page, its state (rose while it needs a permission) and since when, and Watch
// when orrery started it. It sticks to the top of the page as it scrolls, so who's on it stays in sight; being in the
// flow, it covers nothing and doesn't jump. `since` is when the session took the issue; without it (an issue it
// took before orrery kept that), since when it's been in its state.
const props = defineProps<{session: Session, since?: string}>()
const {load} = useOwner()
const {settings} = useAppSettings()
const opening = ref(false)
const failed = ref('')

async function watchIt() {
    const launch = props.session.started?.launch
    if (!launch) return
    opening.value = true
    failed.value = ''
    try {
        await $fetch(`/api/projects/${encodeURIComponent(props.session.project)}/launches/${launch}/watch`, {
            method: 'POST', headers: {'Orrery-Actor': await load()}, body: {},
        })
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        opening.value = false
    }
}
</script>

<template>
  <div class="sticky top-0 z-20 bg-panel" data-testid="issue-worker">
    <div class="border-b border-accent-500/20 bg-accent-500/10">
      <div class="mx-auto flex max-w-6xl flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 text-sm sm:px-8">
        <span class="relative flex size-2 shrink-0">
          <span v-if="session.state === 'working'" class="absolute inline-flex size-full animate-ping rounded-full bg-accent-400 opacity-60" />
          <SessionDot :session="session" />
        </span>
        <span class="min-w-0">
          <NuxtLink
              :to="`/sessions#session-${session.id}`"
              class="font-medium text-fg hover:underline"
              :title="`Open ${session.name} on the Sessions page`"
          >{{ session.name }}</NuxtLink>
          <span class="text-muted"> is working on this</span>
        </span>
        <span class="text-xs" :class="session.state === 'waiting' ? 'text-rose-600 dark:text-rose-400' : 'text-muted'">
          {{ SESSION_STATE[session.state] }}<span class="text-faint" :title="since ? 'When it took this issue' : 'When it got into this state'"> · {{ since ? 'took it' : 'since' }} {{ ago(since ?? session.since) }}</span>
        </span>
        <span v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</span>
        <UiButton
            v-if="session.started"
            size="xs"
            class="ml-auto"
            :disabled="opening"
            :title="`Open ${TERMINALS[settings.terminal]} on ${session.name}, on its launcher's machine`"
            @click="watchIt"
        >
          {{ opening ? 'Opening…' : 'Watch' }}
        </UiButton>
      </div>
    </div>
  </div>
</template>
