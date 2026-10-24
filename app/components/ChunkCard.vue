<script setup lang="ts">
import type {Chunk} from '#shared/roadmap'
import {COLUMNS, total} from '#shared/roadmap'

// A chunk on the board: its progress, where its leaves are, and (open) its issues.
const props = defineProps<{chunk: Chunk, project: string, open: boolean}>()
const emit = defineEmits<{toggle: []}>()
const {open: openIssue, isOpen} = useIssueLink()

const share = computed(() => progress(props.chunk.counts))
const spread = computed(() => COLUMNS.filter(c => c !== 'done' && props.chunk.counts[c]).map(c => ({column: c, n: props.chunk.counts[c]})))
</script>

<template>
  <article class="rounded-xl border border-line bg-panel shadow-sm shadow-black/5 transition-colors hover:border-faint/40 dark:shadow-black/30">
    <div
        data-nav
        tabindex="0"
        role="button"
        :aria-expanded="open"
        class="flex cursor-pointer flex-col gap-2.5 rounded-xl p-3 outline-none focus-visible:ring-2 focus-visible:ring-accent-500/50"
        @click="emit('toggle')"
    >
      <div class="flex items-start gap-2">
        <StatusIcon :column="chunk.column" :progress="share.share" class="mt-0.5" />
        <h3 class="min-w-0 flex-1 text-[13px] leading-snug font-medium" :class="chunk.id ? 'text-fg' : 'text-muted italic'">{{ chunk.title }}</h3>
        <svg class="mt-0.5 size-3.5 shrink-0 text-faint transition-transform" :class="open && 'rotate-90'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
      </div>
      <p v-if="chunk.summary" class="line-clamp-2 text-xs leading-relaxed text-muted"><InlineText :text="chunk.summary" /></p>
      <ColumnBar :counts="chunk.counts" />
      <div class="flex items-center gap-2 text-[11px] text-faint">
        <ProgressRing :counts="chunk.counts" :size="13" />
        <span class="ml-auto flex items-center gap-2">
          <span v-for="part in spread" :key="part.column" class="flex items-center gap-1" :title="`${part.n} ${COLUMN_STYLE[part.column].label}`">
            <span class="size-1.5 rounded-full" :class="COLUMN_STYLE[part.column].fill" />{{ part.n }}
          </span>
        </span>
      </div>
    </div>
    <ul v-if="open" class="flex flex-col border-t border-line py-1">
      <li v-for="issue in chunk.tasks" :key="issue.id">
        <div
            data-nav
            :data-issue="issue.id"
            tabindex="0"
            role="button"
            class="mx-1 flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs outline-none hover:bg-hover focus-visible:bg-active"
            :class="isOpen(project, issue.id) && 'bg-active'"
            @click="openIssue(project, issue.id)"
        >
          <StatusIcon :column="issue.column" :progress="progress(issue.counts).share" :size="13" />
          <span class="w-12 shrink-0 truncate font-mono text-[10px] text-faint">{{ issue.id }}</span>
          <span class="min-w-0 flex-1 truncate" :class="issue.column === 'done' ? 'text-muted' : 'text-fg'">{{ issue.title }}</span>
          <span v-if="issue.tasks.length" class="font-mono text-[10px] text-faint">{{ issue.counts.done }}/{{ total(issue.counts) }}</span>
          <PriorityIcon :priority="issue.priority" :size="12" />
          <PersonAvatar v-if="issue.assignee" :name="issue.assignee" :size="15" />
        </div>
      </li>
      <li v-if="!chunk.tasks.length" class="px-3 py-2 text-xs text-faint">No issues yet</li>
    </ul>
  </article>
</template>
