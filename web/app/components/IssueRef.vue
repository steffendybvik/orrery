<script setup lang="ts">
// An issue another links to (ORR-601), by its `linkRef` read in `here`: its status and id, linking to its page (in its
// own project, for one in another), with its title on hover. One the page doesn't have (closed, in a project read
// without them) shows its id alone.
const props = defineProps<{link: string, here: string}>()
const {projects} = useRoadmaps()
const {pathOf} = useIssueLink()
const linked = computed(() => linkedIssue(projects.value, props.here, props.link))
</script>

<template>
  <NuxtLink
      :to="pathOf(linked.project, linked.id)"
      class="inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 font-mono text-[11px] text-muted ring-1 ring-line hover:bg-hover hover:text-fg"
      :title="linked.issue ? `${link} · ${linked.issue.title}` : link"
      @click.stop
  >
    <StatusIcon v-if="linked.issue" :column="linked.issue.column" :size="12" />
    <span class="truncate">{{ link }}</span>
  </NuxtLink>
</template>
