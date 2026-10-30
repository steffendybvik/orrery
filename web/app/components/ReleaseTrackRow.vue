<script setup lang="ts">
import type {TrackedRelease} from '#shared/roadmap'

// A release on the Releases page, opening its page: its version, state, branch and progress, and, when several projects
// share it, each one's progress under it.
defineProps<{project: string, release: TrackedRelease}>()
const {byId} = useRoadmaps()
const issues = (n: number) => `${n} ${n === 1 ? 'issue' : 'issues'}`
</script>

<template>
  <li class="border-b border-line last:border-b-0">
    <NuxtLink :to="releasePath(project, release.version)" class="flex flex-col gap-1.5 px-3 py-2 hover:tint">
      <span class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span class="font-mono text-[13px] font-medium text-fg">{{ release.version }}</span>
        <ReleaseStateChip :release="release" />
        <span v-if="release.branch" class="font-mono text-xs text-faint">{{ release.branch }}</span>
        <span class="ml-auto flex items-center gap-3 text-xs text-faint">
          <span>{{ issues(release.issues) }}</span>
          <ProgressRing :kinds="release.kinds" />
        </span>
      </span>
      <span v-if="release.projects.length > 1" class="flex flex-col gap-1 border-l border-line pl-3">
        <span v-for="part in release.projects" :key="part.project" class="flex items-center gap-3 text-xs text-muted">
          <span class="min-w-0 truncate">{{ byId(part.project)?.name ?? part.project }}</span>
          <span class="ml-auto shrink-0 text-faint">{{ issues(part.issues) }}</span>
          <ProgressRing :kinds="part.kinds" />
        </span>
      </span>
    </NuxtLink>
  </li>
</template>
