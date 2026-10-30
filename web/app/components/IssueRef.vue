<script setup lang="ts">
// An issue another links to (ORR-601), by its `linkRef` read in `here`: its status and id, linking to its page (in its
// own project, for one in another), with its title on hover. One the page doesn't have (closed, in a project read
// without them) shows its id alone. With `removeLabel`, a × beside it asks to take the link off (ORR-680).
const props = defineProps<{link: string, here: string, removeLabel?: string}>()
const emit = defineEmits<{remove: []}>()
const {projects} = useRoadmaps()
const {pathOf} = useIssueLink()
const linked = computed(() => linkedIssue(projects.value, props.here, props.link))
</script>

<template>
  <span class="inline-flex h-6 max-w-full min-w-0 items-center rounded-md font-mono text-[11px] text-muted ring-1 ring-line">
    <NuxtLink
        :to="pathOf(linked.project, linked.id)"
        class="inline-flex h-full min-w-0 items-center gap-1.5 rounded-md px-1.5 hover:bg-hover hover:text-fg"
        :title="linked.issue ? `${link} · ${linked.issue.title}` : link"
        @click.stop
    >
      <StatusIcon v-if="linked.issue" :column="linked.issue.column" :size="12" />
      <span class="truncate">{{ link }}</span>
    </NuxtLink>
    <button
        v-if="removeLabel"
        type="button"
        class="flex h-full w-5 shrink-0 items-center justify-center rounded-md text-faint hover:bg-hover hover:text-fg"
        :aria-label="removeLabel"
        :title="removeLabel"
        @click.stop="emit('remove')"
    >×</button>
  </span>
</template>
