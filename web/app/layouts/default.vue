<script setup lang="ts">
useHotkeys()
// Who the owner is, so the page shows their name (`who`)
const {load} = useOwner()
await callOnce('owner', load)

// The dialogs load the first time they open, each in its own chunk, and then stay; ⌘K's palette, the menus and
// the bar are there from the start, as they listen for keys or show on a right-click.
function openedOnce(open: () => unknown) {
    const opened = ref(false)
    watch(open, now => {
        if (now) opened.value = true
    }, {immediate: true})
    return opened
}
const {target: newIssue} = useNewIssue()
const {target: newChunk} = useNewChunk()
const {target: startSession} = useStartSession()
const {editing: schedule} = useSchedules()
const newProject = useState('new-project', () => false)
const issueDialog = openedOnce(() => newIssue.value)
const chunkDialog = openedOnce(() => newChunk.value)
const sessionDialog = openedOnce(() => startSession.value)
const scheduleDialog = openedOnce(() => schedule.value)
const projectDialog = openedOnce(() => newProject.value)
</script>

<template>
  <div class="flex h-dvh overflow-hidden">
    <AppSidebar />
    <main class="flex min-w-0 flex-1 flex-col overflow-hidden">
      <slot />
    </main>
    <CommandPalette />
    <LazyNewIssueDialog v-if="issueDialog" />
    <IssueMenu />
    <ChunkMenu />
    <LazyScheduleDialog v-if="scheduleDialog" />
    <LazyNewProjectDialog v-if="projectDialog" />
    <LazyNewChunkDialog v-if="chunkDialog" />
    <LazyStartSessionDialog v-if="sessionDialog" />
    <ScheduleMenu />
    <OwnerDialog />
    <ImageView />
    <BulkBar />
  </div>
</template>
