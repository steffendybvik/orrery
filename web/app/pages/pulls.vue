<script setup lang="ts">
import {PULL_NEEDS} from '#shared/roadmap'

// Every open pull request on the projects' GitHub repos (ORR-491), so one doesn't wait unseen once its issue is in
// review or done. Each repo is its own card (ORR-603): repos with a PR that needs someone first, then the rest by name.
// Its header names the repo, its projects, how many are open and how it was read (with or without a token, and why it
// couldn't be read). Inside, those that need someone (conflicts, failing checks, behind) first, oldest first, then the
// rest. Each row has the PR, where it stands, its branch and age, and the issue it names, if a project has it. Poll
// asks GitHub now rather than waiting for the background poll's next turn; a repo it held back (GitHub's limits) says
// why in its header.
useHead({title: 'Pull requests · orrery'})
const {projects, ready, byId} = useRoadmaps()
const {pulls, follow, poll, polling, failed} = useOpenPulls()
follow(60_000)
const needs = (state: string) => (PULL_NEEDS as string[]).includes(state)
// The repos GitHub couldn't be read for: their pull requests aren't in the list, so it can't say none are open (ORR-552).
const unread = computed(() => pulls.value?.repos.filter(r => r.error).length ?? 0)
const noneRead = computed(() => !!unread.value && unread.value === pulls.value?.repos.length)
// The repos as cards, each with its own pull requests in the answer's order.
const cards = computed(() => (pulls.value?.repos ?? []).map(repo => {
    const own = (pulls.value?.pulls ?? []).filter(p => p.repo === repo.repo)
    return {...repo, pulls: own, needs: own.filter(p => needs(p.state)).length}
}).sort((a, b) => Number(!a.needs) - Number(!b.needs) || a.repo.localeCompare(b.repo)))
</script>

<template>
  <PageHeader>
    <svg class="size-4 shrink-0 text-accent-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M6 8.5v7M18 15.5V9a3 3 0 0 0-3-3h-4m2-2-2 2 2 2" /></svg>
    <h1 class="truncate text-sm font-medium">Pull requests</h1>
  </PageHeader>

  <ViewToolbar>
    <span class="text-xs text-muted">
      <template v-if="!pulls">Asking GitHub…</template>
      <template v-else-if="pulls.pulls.length">{{ pulls.pulls.length }} open{{ pulls.needs ? `, ${pulls.needs} need${pulls.needs === 1 ? 's' : ''} someone` : '' }}</template>
      <template v-else-if="noneRead">Couldn't read GitHub</template>
      <template v-else>None open</template>
      <template v-if="unread && !noneRead">, {{ unread }} repo{{ unread === 1 ? '' : 's' }} not read</template>
    </span>
    <span v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</span>
    <template #end>
      <UiButton class="shrink-0" :disabled="polling || !pulls?.repos.length" title="Ask GitHub now, rather than at the next poll" @click="poll">
        <svg class="size-3.5" :class="{'animate-spin motion-reduce:animate-none': polling}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5" /></svg>
        {{ polling ? 'Polling…' : 'Poll' }}
      </UiButton>
    </template>
  </ViewToolbar>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <EmptyProjects v-if="ready && !projects.length" />
    <div v-else class="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-6">
      <p v-if="pulls && !pulls.repos.length" class="rounded-xl border border-dashed border-line px-4 py-10 text-center text-[13px] leading-relaxed text-muted">
        No project's repo is on GitHub. Set one's repo (<code>https://github.com/you/shop</code>) in its Settings, and its open pull requests show here.
      </p>
      <ul v-else-if="pulls" class="flex flex-col gap-4" aria-label="Repos">
        <li v-for="card in cards" :key="card.repo" class="overflow-hidden rounded-xl border border-line dark:bg-panel">
          <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2" :class="{'border-b border-line': card.pulls.length || card.error}">
            <a :href="`https://github.com/${card.repo}/pulls`" target="_blank" rel="noopener" class="font-mono text-[13px] text-fg hover:underline">{{ card.repo }}</a>
            <span class="text-xs text-muted">{{ card.projects.map(p => byId(p)?.name ?? p).join(', ') }}</span>
            <span v-if="!card.error" class="ml-auto text-xs" :class="card.needs ? 'text-rose-600 dark:text-rose-400' : 'text-muted'">
              <template v-if="card.pulls.length">{{ card.pulls.length }} open{{ card.needs ? `, ${card.needs} need${card.needs === 1 ? 's' : ''} someone` : '' }}</template>
              <template v-else>none open</template>
            </span>
            <span class="w-full text-[11px] text-faint">
              <template v-if="card.error">not read</template>
              <template v-else-if="card.token">read with the GITHUB_TOKEN secret{{ card.checked_at ? `, ${ago(card.checked_at)}` : '' }}</template>
              <template v-else>read without a token, so only the list: set a GITHUB_TOKEN secret for api.github.com to see where each stands</template>
              <template v-if="card.held"> · <span class="text-amber-700 dark:text-amber-400">not polled now: {{ card.held }}</span></template>
            </span>
          </div>
          <p v-if="card.error" class="px-3 py-2 text-xs text-rose-600 dark:text-rose-400">{{ card.error }}</p>
          <ul v-else-if="card.pulls.length" :aria-label="`Open pull requests on ${card.repo}`">
            <li v-for="pull in card.pulls" :key="pull.number" class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2 text-sm last:border-b-0" :class="{'bg-rose-500/5': needs(pull.state)}">
              <a :href="pull.url" target="_blank" rel="noopener" class="min-w-0 flex-1 truncate text-fg hover:underline">
                <span class="font-mono text-xs text-faint">#{{ pull.number }}</span> {{ pull.title }}
              </a>
              <PullStateChip :state="pull.state" />
              <span class="flex w-full min-w-0 items-center gap-2 text-[11px] text-faint">
                <NuxtLink
                    v-if="pull.issue"
                    :to="`/p/${pull.issue.project}/issues/${pull.issue.id}`"
                    class="shrink-0 font-mono text-muted hover:text-fg hover:underline"
                    :title="`${byId(pull.issue.project)?.name ?? pull.issue.project}: ${pull.issue.title}`"
                >{{ pull.issue.id }}</NuxtLink>
                <span v-else class="shrink-0">no issue</span>
                <span class="min-w-0 truncate font-mono" :title="`${pull.branch} into ${pull.base}, by ${pull.author}`">{{ pull.branch }} → {{ pull.base }}</span>
                <span class="ml-auto shrink-0">{{ ago(pull.created_at) }}</span>
              </span>
            </li>
          </ul>
        </li>
      </ul>
    </div>
  </div>
</template>
