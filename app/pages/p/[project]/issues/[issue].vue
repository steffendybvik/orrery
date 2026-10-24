<script setup lang="ts">
import type {Comment} from '#shared/roadmap'
import {total} from '#shared/roadmap'

// An issue's own page: its title and full description, sub-issues and activity, with its
// properties beside them. j/k go to the next and previous issue in the project, Esc goes back.
const route = useRoute()
const router = useRouter()
const {byId, ready} = useRoadmaps()
const {open, last} = useIssueLink()

const project = computed(() => byId(route.params.project as string))
const issueId = computed(() => route.params.issue as string)
const found = computed(() => findIssue(project.value, issueId.value))
const issue = computed(() => found.value?.issue)
const order = computed(() => project.value ? allIssues(project.value).map(i => i.issue.id) : [])
const at = computed(() => order.value.indexOf(issueId.value))

watch(() => [project.value?.id, issueId.value] as const, ([p, i]) => {
    if (p && i) last.value = `${p}/${i}`
}, {immediate: true})

const comments = ref<Comment[]>([])
watch(() => [project.value?.id, issueId.value, issue.value?.updatedAt] as const, async ([p, i]) => {
    if (!p || !i || !issue.value) return
    comments.value = await $fetch<Comment[]>(`/api/projects/${encodeURIComponent(p)}/issues/${encodeURIComponent(i)}/comments`).catch(() => [])
}, {immediate: true})

/** Back to the board or list it was opened from, else the project. */
function back() {
    const from = (history.state as {back?: string} | null)?.back
    if (from && from.startsWith(`/p/${route.params.project}`) && !from.includes('/issues/')) router.back()
    else router.push(`/p/${route.params.project}`)
}

function step(by: number) {
    const next = order.value[at.value + by]
    if (next && project.value) router.replace(`/p/${project.value.id}/issues/${encodeURIComponent(next)}`)
}

function onKey(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null
    if (event.metaKey || event.ctrlKey || event.altKey || useState('palette-open').value) return
    if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
    if (event.key === 'j') step(1)
    else if (event.key === 'k') step(-1)
    else if (event.key === 'Escape') back()
    else return
    event.preventDefault()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

const copied = ref(false)
async function copyId() {
    await navigator.clipboard?.writeText(issueId.value)
    copied.value = true
    setTimeout(() => copied.value = false, 1200)
}

useHead(() => ({title: issue.value ? `${issue.value.id} ${issue.value.title} · Orrery` : 'Orrery'}))
</script>

<template>
  <PageHeader>
    <template v-if="project">
      <button type="button" class="-ml-1 hidden rounded-md p-1 text-faint hover:bg-hover hover:text-fg md:block" title="Back (Esc)" aria-label="Back" @click="back">
        <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 6-6 6 6 6" /></svg>
      </button>
      <nav class="flex min-w-0 items-center gap-1.5 text-sm" aria-label="Breadcrumb">
        <NuxtLink :to="`/p/${project.id}`" class="shrink-0 font-medium hover:text-fg">{{ project.name }}</NuxtLink>
        <template v-if="found">
          <span class="text-faint">/</span>
          <NuxtLink :to="chunkPath(project.id, found.chunk.id)" class="hidden max-w-48 truncate text-muted hover:text-fg sm:inline">{{ found.chunk.title }}</NuxtLink>
          <template v-for="parent in found.parents" :key="parent.id">
            <span class="hidden text-faint sm:inline">/</span>
            <button type="button" class="hidden font-mono text-xs text-muted hover:text-fg sm:inline" @click="open(project.id, parent.id)">{{ parent.id }}</button>
          </template>
          <span class="hidden text-faint sm:inline">/</span>
          <span class="truncate font-mono text-xs text-fg">{{ issueId }}</span>
        </template>
      </nav>
    </template>
    <template v-if="project && at >= 0" #actions>
      <div class="ml-auto flex items-center gap-1 text-xs text-faint">
        <span class="mr-1 font-mono tabular-nums">{{ at + 1 }} / {{ order.length }}</span>
        <button type="button" class="rounded-md p-1 hover:bg-hover hover:text-fg disabled:opacity-30" :disabled="at <= 0" title="Previous (k)" aria-label="Previous issue" @click="step(-1)">
          <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6" /></svg>
        </button>
        <button type="button" class="rounded-md p-1 hover:bg-hover hover:text-fg disabled:opacity-30" :disabled="at >= order.length - 1" title="Next (j)" aria-label="Next issue" @click="step(1)">
          <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg>
        </button>
      </div>
    </template>
  </PageHeader>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <div v-if="issue && found && project" :key="issue.id" class="mx-auto flex max-w-6xl animate-fade-up flex-col lg:flex-row">
      <article class="flex min-w-0 flex-1 flex-col gap-8 px-4 py-6 sm:px-8 sm:py-10">
        <header class="flex flex-col gap-2">
          <button type="button" class="flex w-fit items-center gap-1.5 font-mono text-xs text-faint hover:text-fg" title="Copy the id" @click="copyId">
            {{ issue.id }}
            <span v-if="copied" class="font-sans text-emerald-500">copied</span>
          </button>
          <h1 class="text-xl leading-snug font-semibold tracking-tight text-fg sm:text-2xl"><InlineText :text="issue.title" /></h1>
        </header>

        <div class="lg:hidden">
          <IssueProperties :issue="issue" :project="project" :chunk="found.chunk" />
        </div>

        <section>
          <MarkdownView v-if="issue.notes" :source="issue.notes" />
          <p v-else class="text-sm text-faint italic">No description.</p>
        </section>

        <section v-if="issue.tasks.length" class="flex flex-col gap-2">
          <h2 class="label flex items-center gap-2">Sub-issues <span class="font-mono normal-case">{{ issue.counts.done }}/{{ total(issue.counts) }}</span></h2>
          <div class="overflow-hidden rounded-xl border border-line">
            <IssueRow v-for="sub in issue.tasks" :key="sub.id" :issue="sub" :project="project.id" nested class="last:border-b-0" />
          </div>
        </section>

        <section class="flex flex-col gap-3">
          <h2 class="label">Activity</h2>
          <ol class="relative flex flex-col gap-5 border-l border-line pl-5">
            <li class="text-xs text-faint">
              <span class="absolute -left-[3px] mt-1.5 size-1.5 rounded-full bg-faint/60" />
              <span class="text-muted">{{ issue.createdBy }}</span> created the issue · <span :title="issue.createdAt">{{ ago(issue.createdAt) }}</span>
            </li>
            <li v-for="comment in comments" :key="comment.id" class="flex flex-col gap-1.5">
              <div class="-ml-[31px] flex items-center gap-2 text-xs">
                <PersonAvatar :name="comment.createdBy" :size="20" />
                <span class="font-medium text-fg">{{ comment.createdBy }}</span>
                <span class="text-faint" :title="comment.createdAt">{{ ago(comment.createdAt) }}{{ comment.updatedAt !== comment.createdAt ? ' · edited' : '' }}</span>
              </div>
              <div class="rounded-xl bg-well px-4 py-3 ring-1 ring-line"><MarkdownView :source="comment.body" class="text-[13px] leading-6" /></div>
            </li>
          </ol>
        </section>

        <p class="rounded-lg bg-well px-3 py-2 font-mono text-[11px] text-faint ring-1 ring-line">PATCH /api/projects/{{ project.id }}/issues/{{ issue.id }}</p>
      </article>

      <aside class="hidden w-80 shrink-0 border-l border-line px-6 py-10 lg:block">
        <div class="sticky top-6">
          <IssueProperties :issue="issue" :project="project" :chunk="found.chunk" />
        </div>
      </aside>
    </div>

    <div v-else-if="ready" class="grid place-items-center px-4 py-24 text-center text-sm text-muted">
      <div class="flex flex-col items-center gap-2">
        <p>No issue <span class="font-mono">{{ issueId }}</span>{{ project ? ` in ${project.name}` : '' }}.</p>
        <p class="text-xs text-faint">It may have moved or been deleted.</p>
        <NuxtLink :to="project ? `/p/${project.id}` : '/now'" class="mt-2 text-xs text-fg underline">Back</NuxtLink>
      </div>
    </div>
  </div>
</template>
