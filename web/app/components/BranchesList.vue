<script setup lang="ts">
import type {AllBranches, BranchVerdict, RepoBranch} from '#shared/roadmap'

// Every branch on the projects' GitHub repos (ORR-793), a card per repo: its issue and pull request, its age, how many
// commits aren't in the base, and whether to remove it, keep it or look at it first. Only one that reads as remove can be
// removed from here, and only after asking; nothing goes without the owner. A repo read without a token says what it can't tell.
const {load: owner} = useOwner()
const got = ref<AllBranches>()
const failed = ref('')
const removing = ref<string | null>(null)
const asking = ref<string | null>(null)
const refused = ref<Record<string, string>>({})
const key = (branch: RepoBranch) => `${branch.repo}:${branch.name}`

async function load() {
    try {
        got.value = await owner().then(actor => apiFetch<AllBranches>('/pulls/branches', {headers: {'Orrery-Actor': actor}}))
        failed.value = ''
    } catch (error) {
        failed.value = errorMessage(error, 'read')
    }
}
onMounted(load)

async function remove(branch: RepoBranch) {
    removing.value = key(branch)
    const {[key(branch)]: _left, ...others} = refused.value
    refused.value = others
    try {
        await apiFetch('/pulls/branches', {method: 'DELETE', query: {repo: branch.repo, name: branch.name}})
        asking.value = null
        await load()
    } catch (error) {
        asking.value = null
        refused.value = {...refused.value, [key(branch)]: errorMessage(error, 'remove')}
    } finally {
        removing.value = null
    }
}

const TONE: Record<BranchVerdict, string> = {
    remove: 'text-rose-700 ring-rose-500/40 bg-rose-500/10 dark:text-rose-400',
    keep: 'text-muted ring-line',
    look: 'text-amber-800 ring-amber-500/40 bg-amber-500/10 dark:text-amber-400',
}
const VERDICT: Record<BranchVerdict, string> = {remove: 'Remove', keep: 'Keep', look: 'Look'}
const count = (verdict: BranchVerdict) => got.value?.branches.filter(b => b.verdict === verdict).length ?? 0
const own = (repo: string) => got.value?.branches.filter(b => b.repo === repo) ?? []
const short = (branch: RepoBranch) => branch.sha.slice(0, 7)
</script>

<template>
  <div class="flex flex-col gap-3 p-4">
    <p class="text-xs text-muted">
      <template v-if="got">{{ got.branches.length }} {{ got.branches.length === 1 ? 'branch' : 'branches' }}: {{ count('look') }} to look at, {{ count('remove') }} to remove, {{ count('keep') }} to keep</template>
      <template v-else-if="!failed">Asking GitHub…</template>
    </p>
    <p v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">{{ failed }}</p>
    <p v-if="got && !got.repos.length" class="text-[13px] text-muted">No project points at a repo on GitHub.</p>
    <ul v-if="got?.repos.length" class="flex flex-col gap-3" aria-label="Repos">
      <li v-for="repo in got.repos" :key="repo.repo" class="rounded-xl border border-line dark:bg-panel">
        <div class="flex flex-wrap items-baseline gap-x-2 border-b border-line px-3 py-2 text-xs text-faint">
          <span class="font-mono text-[13px] text-fg">{{ repo.repo }}</span>
          <span v-if="repo.base">commits counted against {{ repo.base }}</span>
          <span v-else-if="!repo.error">read without a token, so no age or commit count: set a GITHUB_TOKEN secret for api.github.com</span>
          <span v-if="repo.cut" class="text-amber-800 dark:text-amber-400">only the first {{ repo.cut }} read</span>
          <span v-if="repo.error" class="text-rose-700 dark:text-rose-400">{{ repo.error }}</span>
        </div>
        <ul>
          <li v-for="branch in own(repo.repo)" :key="branch.name" class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2 text-sm last:border-b-0">
            <span class="min-w-0 flex-1 truncate font-mono text-xs text-fg" :title="branch.name">{{ branch.name }}</span>
            <NuxtLink v-if="branch.issue" :to="`/p/${branch.issue.project}/issues/${branch.issue.id}`" class="shrink-0 font-mono text-xs text-muted hover:underline" :title="branch.issue.title">{{ branch.issue.id }}</NuxtLink>
            <a v-if="branch.pull" :href="branch.pull.url" target="_blank" rel="noopener" class="shrink-0 text-xs text-muted hover:underline">#{{ branch.pull.number }} {{ branch.pull.state }}</a>
            <span v-else class="shrink-0 text-xs text-faint">no pull request</span>
            <span class="flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium ring-1" :class="TONE[branch.verdict]" :title="branch.why">{{ VERDICT[branch.verdict] }}</span>
            <UiButton v-if="branch.verdict === 'remove' && asking !== key(branch)" size="xs" :disabled="!!removing" @click="asking = key(branch)">Remove…</UiButton>
            <div class="w-full truncate text-[11px] text-faint">
              {{ branch.why }}<template v-if="branch.committed_at"> · {{ ago(branch.committed_at) }}</template><template v-if="branch.ahead !== null"> · {{ branch.ahead }} {{ branch.ahead === 1 ? 'commit' : 'commits' }} not in {{ repo.base }}</template><template v-if="branch.ahead && branch.pull?.state === 'merged'"> (a squash merge leaves them reading so)</template> · <span class="font-mono">{{ short(branch) }}</span>
            </div>
            <UiConfirm v-if="asking === key(branch)" class="w-full" :busy="removing === key(branch)" @confirm="remove(branch)" @cancel="asking = null">
              Remove {{ branch.name }} from GitHub? Its commits stay only where something else holds them.
            </UiConfirm>
            <p v-if="refused[key(branch)]" class="w-full text-xs text-rose-700 dark:text-rose-400">{{ refused[key(branch)] }}</p>
          </li>
        </ul>
      </li>
    </ul>
  </div>
</template>
