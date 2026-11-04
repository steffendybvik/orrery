<script setup lang="ts">
import type {Milestone} from '#shared/roadmap'

// A milestone on the roadmap: its progress and where its issues are. Clicking opens its page, right-clicking
// its menu (MilestoneMenu).
const props = defineProps<{milestone: Milestone, project: string}>()
const {open: openMenu} = useMilestoneMenu()
const {columns, look} = useStatuses()
const share = computed(() => progress(props.milestone.kinds))
// Where its open issues are (and its proposals), a dot per column.
const spread = computed(() => columns.value.flatMap(c => {
    const n = props.milestone.counts[c.id]
    return !isClosed(c.kind) && n ? [{column: c.id, n}] : []
}))
</script>

<template>
  <NuxtLink
      data-nav
      :to="milestonePath(project, milestone.id)"
      @contextmenu="openMenu($event, project, milestone.id || 'none')"
      class="flex flex-col gap-2.5 rounded-xl border border-line bg-panel p-3 shadow-sm shadow-black/5 outline-none transition-colors hover:border-faint/40 focus-visible:ring-2 focus-visible:ring-accent-500/50 dark:shadow-black/30"
  >
    <div class="flex items-start gap-2">
      <StatusIcon :column="milestone.column" :progress="share.share" class="mt-0.5" />
      <PriorityIcon v-if="milestone.priority" :priority="milestone.priority" class="mt-0.5" />
      <h3 class="min-w-0 flex-1 text-[13px] leading-snug font-medium" :class="milestone.id ? 'text-fg' : 'text-muted italic'">{{ milestone.title }}</h3>
      <span class="font-mono text-[11px] text-faint tabular-nums">{{ milestone.tasks.length }}</span>
    </div>
    <p v-if="milestone.summary" class="line-clamp-2 text-xs leading-relaxed text-muted"><InlineText :text="milestone.summary" /></p>
    <ColumnBar :counts="milestone.counts" />
    <div class="flex items-center gap-2 text-[11px] text-faint">
      <ProgressRing :kinds="milestone.kinds" :size="13" />
      <span class="ml-auto flex items-center gap-2">
        <span v-for="part in spread" :key="part.column" class="flex items-center gap-1" :title="`${part.n} ${look(part.column).label}`">
          <span class="size-1.5 rounded-full" :style="{background: look(part.column).color}" />{{ part.n }}
        </span>
      </span>
    </div>
  </NuxtLink>
</template>
