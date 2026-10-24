<script setup lang="ts">
import type {Comment} from '#shared/roadmap'
import {total} from '#shared/roadmap'

// The issue the URL names (`?issue=`), on the right: its properties, notes, sub-issues and comments.
// Read-only: issues change through the API, and the panel follows along.
const {byId} = useRoadmaps()
const {projectId, issueId, open, close} = useIssueLink()

const project = computed(() => byId(projectId.value))
const found = computed(() => issueId.value ? findIssue(project.value, issueId.value) : null)
const issue = computed(() => found.value?.issue)

const comments = ref<Comment[]>([])
watch(() => [projectId.value, issueId.value, issue.value?.updatedAt] as const, async ([p, i]) => {
    if (!p || !i || !issue.value) return
    comments.value = await $fetch<Comment[]>(`/api/projects/${encodeURIComponent(p)}/issues/${encodeURIComponent(i)}/comments`).catch(() => [])
}, {immediate: true})
watch(issueId, () => {
    comments.value = []
})

const copied = ref(false)
async function copyId() {
    if (!issue.value) return
    await navigator.clipboard?.writeText(issue.value.id)
    copied.value = true
    setTimeout(() => copied.value = false, 1200)
}
</script>

<template>
  <Transition enter-from-class="opacity-0 translate-x-6" enter-active-class="transition duration-200 ease-out" leave-to-class="opacity-0 translate-x-6" leave-active-class="transition duration-150 ease-in">
    <aside
        v-if="issueId"
        class="glass fixed inset-0 z-40 flex flex-col overflow-hidden sm:inset-y-2 sm:right-2 sm:left-auto sm:w-[min(520px,calc(100vw-1rem))] sm:rounded-2xl"
        aria-label="Issue"
    >
      <header class="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <div class="label flex min-w-0 flex-1 items-center gap-1.5 normal-case">
          <NuxtLink v-if="project" :to="`/p/${project.id}`" class="truncate hover:text-fg">{{ project.name }}</NuxtLink>
          <template v-if="found">
            <span>/</span><span class="truncate">{{ found.chunk.title }}</span>
            <template v-for="parent in found.parents" :key="parent.id">
              <span>/</span>
              <button type="button" class="font-mono hover:text-fg" @click="open(project!.id, parent.id)">{{ parent.id }}</button>
            </template>
          </template>
        </div>
        <button type="button" class="rounded-md p-1 text-faint hover:bg-hover hover:text-fg" aria-label="Close (Esc)" title="Close (Esc)" @click="close">
          <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </header>

      <div v-if="issue && found && project" :key="issue.id" class="flex min-h-0 flex-1 animate-slide-in flex-col gap-6 overflow-y-auto px-5 py-5">
        <div class="flex flex-col gap-2">
          <button type="button" class="flex w-fit items-center gap-1.5 font-mono text-xs text-faint hover:text-fg" title="Copy the id" @click="copyId">
            {{ issue.id }}
            <span v-if="copied" class="font-sans text-emerald-500">copied</span>
          </button>
          <h2 class="text-lg leading-snug font-semibold tracking-tight text-fg"><InlineText :text="issue.title" /></h2>
        </div>

        <dl class="grid grid-cols-[7rem_1fr] items-center gap-x-3 gap-y-2.5 text-[13px]">
          <dt class="label">Status</dt>
          <dd class="flex items-center gap-2">
            <StatusIcon :column="issue.column" :progress="progress(issue.counts).share" />
            <span>{{ COLUMN_STYLE[issue.column].label }}</span>
            <span v-if="issue.tasks.length" class="text-xs text-faint">from its sub-issues</span>
            <span v-else-if="issue.status === 'todo'" class="text-xs text-faint">{{ issue.plan ? `to do, planned ${issue.plan}` : 'to do, unplanned' }}</span>
          </dd>
          <dt class="label">Priority</dt>
          <dd class="flex items-center gap-2"><PriorityIcon :priority="issue.priority" />{{ issue.priority ? `${issue.priority} · ${PRIORITY_LABEL[issue.priority]}` : 'No priority' }}</dd>
          <dt class="label">Assignee</dt>
          <dd class="flex items-center gap-2">
            <template v-if="issue.assignee"><PersonAvatar :name="issue.assignee" />{{ issue.assignee }}</template>
            <span v-else class="text-faint">Unassigned</span>
          </dd>
          <dt class="label">Labels</dt>
          <dd class="flex flex-wrap gap-1">
            <LabelChip v-for="label in issue.labels" :key="label" :label="label" />
            <span v-if="!issue.labels.length" class="text-faint">None</span>
          </dd>
          <dt class="label">Project</dt>
          <dd><NuxtLink :to="`/p/${project.id}`" class="hover:underline">{{ project.name }}</NuxtLink></dd>
          <dt class="label">Chunk</dt>
          <dd class="truncate" :class="!found.chunk.id && 'text-faint'">{{ found.chunk.title }}</dd>
          <template v-if="issue.tasks.length">
            <dt class="label">Progress</dt>
            <dd class="flex items-center gap-3"><ProgressRing :counts="issue.counts" /><ColumnBar :counts="issue.counts" class="max-w-40" /></dd>
          </template>
          <dt class="label">Created by</dt>
          <dd class="flex items-center gap-2 text-muted">
            {{ issue.createdBy }}
            <span v-if="issue.protected" class="flex items-center gap-1 text-xs text-faint" title="Only the owner can delete it">
              <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
              protected
            </span>
            <span class="text-xs text-faint" :title="issue.createdAt">· {{ ago(issue.createdAt) }}</span>
          </dd>
        </dl>

        <section v-if="issue.notes" class="flex flex-col gap-2">
          <h3 class="label">Notes</h3>
          <p class="text-[13px] leading-relaxed whitespace-pre-wrap text-muted"><InlineText :text="issue.notes" /></p>
        </section>

        <section v-if="issue.tasks.length" class="flex flex-col gap-2">
          <h3 class="label flex items-center gap-2">Sub-issues <span class="font-mono normal-case">{{ issue.counts.done }}/{{ total(issue.counts) }}</span></h3>
          <div class="-mx-5 border-t border-line/60">
            <IssueRow v-for="sub in issue.tasks" :key="sub.id" :issue="sub" :project="project.id" />
          </div>
        </section>

        <section class="flex flex-col gap-3">
          <h3 class="label">Activity</h3>
          <ol class="relative flex flex-col gap-4 border-l border-line pl-4">
            <li class="text-xs text-faint">
              <span class="absolute -left-[3px] mt-1.5 size-1.5 rounded-full bg-faint/60" />
              <span class="text-muted">{{ issue.createdBy }}</span> created the issue · {{ ago(issue.createdAt) }}
            </li>
            <li v-for="comment in comments" :key="comment.id" class="flex flex-col gap-1.5">
              <div class="-ml-[27px] flex items-center gap-2 text-xs">
                <PersonAvatar :name="comment.createdBy" :size="20" />
                <span class="font-medium text-fg">{{ comment.createdBy }}</span>
                <span class="text-faint" :title="comment.createdAt">{{ ago(comment.createdAt) }}{{ comment.updatedAt !== comment.createdAt ? ' · edited' : '' }}</span>
              </div>
              <p class="rounded-xl bg-well px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-fg ring-1 ring-line"><InlineText :text="comment.body" /></p>
            </li>
          </ol>
        </section>

        <p class="mt-auto rounded-lg bg-well px-3 py-2 font-mono text-[11px] leading-relaxed text-faint ring-1 ring-line">
          PATCH /api/projects/{{ project.id }}/issues/{{ issue.id }}
        </p>
      </div>

      <div v-else class="grid flex-1 place-items-center p-8 text-center text-sm text-muted">
        <div class="flex flex-col items-center gap-2">
          <p>No issue <span class="font-mono">{{ issueId }}</span>{{ project ? ` in ${project.name}` : '' }}.</p>
          <p class="text-xs text-faint">It may have moved or been deleted.</p>
        </div>
      </div>
    </aside>
  </Transition>
</template>
