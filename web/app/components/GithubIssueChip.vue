<script setup lang="ts">
import {githubIssueLabel, githubIssueUrl, githubRepo} from '#shared/roadmap'

// A GitHub issue an issue came from (ORR-635), `owner/name#523`, as a link: `#523` when it's on the project's own repo.
const props = defineProps<{issue: string, repo?: string}>()
const label = computed(() => githubIssueLabel(props.issue, githubRepo(props.repo)))
</script>

<template>
  <a
      :href="githubIssueUrl(issue)"
      target="_blank"
      rel="noopener"
      class="inline-flex h-5 max-w-36 shrink-0 items-center truncate rounded-md px-1.5 font-mono text-[11px] text-accent-600 ring-1 ring-line hover:bg-hover dark:text-accent-400"
      :title="`Open ${issue} on GitHub`"
      @click.stop
  >{{ label }}</a>
</template>
