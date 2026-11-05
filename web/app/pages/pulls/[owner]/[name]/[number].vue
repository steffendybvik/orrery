<script setup lang="ts">
import type {PullIssues} from '#shared/roadmap'

// One pull request by its number (ORR-880): its title, state and base, a link to it on GitHub, then every issue it's linked
// to, on any project, each with its status and its risk once rated (ORR-914), riskiest first, so a big PR (a release's)
// can be read issue by issue, starting with what matters. It's what orrery keeps
// (`GET /api/pulls/:owner/:name/:number`), merged and closed ones too, so it says so when it keeps nothing of one.
const route = useRoute()
const repo = computed(() => `${route.params.owner}/${route.params.name}`)
const number = computed(() => String(route.params.number).replace(/^#/, ''))
const {look} = useStatuses()
const {data, error} = await useAsyncData(() => `pull-${repo.value}-${number.value}`, () => apiFetch<PullIssues>(`/pulls/${repo.value}/${number.value}`), {watch: [repo, number]})
useHead({title: () => `#${number.value}${data.value ? ` ${data.value.pull.title}` : ''} · orrery`})
</script>

<template>
  <PageHeader>
    <NuxtLink to="/pulls" class="truncate text-sm text-muted hover:text-fg">Pull requests</NuxtLink>
    <span class="text-faint" aria-hidden="true">/</span>
    <h1 class="truncate text-sm font-medium"><span class="font-mono">#{{ number }}</span>{{ data ? ` ${data.pull.title}` : '' }}</h1>
  </PageHeader>

  <div class="clear-agent min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-6">
      <p v-if="error" class="rounded-xl border border-dashed border-line px-4 py-10 text-center text-[13px] leading-relaxed text-muted">
        {{ errorMessage(error, 'read') }}
      </p>
      <template v-else-if="data">
        <section class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line px-3 py-2 text-sm dark:bg-panel" aria-label="The pull request">
          <a :href="data.pull.url" target="_blank" rel="noopener" class="min-w-0 flex-1 truncate font-mono text-[13px] text-fg hover:underline">{{ data.repo }}#{{ data.pull.number }}</a>
          <PullStateChip :state="data.pull.state" />
          <span class="w-full truncate font-mono text-[11px] text-faint">
            <template v-if="data.pull.branch">{{ data.pull.branch }} → </template>{{ data.pull.base }}<template v-if="data.pull.author"> · {{ data.pull.author }}</template> · {{ ago(data.pull.merged_at ?? data.pull.updated_at) }}
          </span>
        </section>
        <h2 class="text-xs font-medium text-muted">{{ data.issues.length }} linked issue{{ data.issues.length === 1 ? '' : 's' }}</h2>
        <ul class="flex flex-col rounded-xl border border-line dark:bg-panel" aria-label="Linked issues">
          <li v-for="issue in data.issues" :key="`${issue.project}/${issue.id}`" class="flex items-center gap-3 border-b border-line px-3 py-2 text-sm last:border-b-0">
            <NuxtLink :to="`/p/${issue.project}/issues/${issue.id}`" class="flex min-w-0 flex-1 items-center gap-2 hover:underline">
              <span class="shrink-0 font-mono text-xs text-muted">{{ issue.id }}</span>
              <span class="min-w-0 truncate text-fg">{{ issue.title }}</span>
            </NuxtLink>
            <RiskChip v-if="issue.risk" :risk="issue.risk" />
            <span class="shrink-0 text-xs text-muted">{{ look(issue.status).label }}</span>
            <span class="shrink-0 text-xs text-faint">{{ issue.project_name }}</span>
          </li>
        </ul>
      </template>
      <UiSpinner v-else />
    </div>
  </div>
</template>
