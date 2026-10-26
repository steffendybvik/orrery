<script setup lang="ts">
useHotkeys()
// Who the owner is, so the page shows their name (`who`)
const {load} = useOwner()
await callOnce('owner', load)
</script>

<template>
  <div class="flex h-dvh overflow-hidden">
    <AppSidebar />
    <main class="flex min-w-0 flex-1 flex-col overflow-hidden">
      <slot />
    </main>
    <CommandPalette />
    <NewIssueDialog />
    <IssueMenu />
    <ChunkMenu />
    <ScheduleDialog />
    <NewProjectDialog />
    <NewChunkDialog />
    <ScheduleMenu />
    <OwnerDialog />
    <BulkBar />
  </div>
</template>
