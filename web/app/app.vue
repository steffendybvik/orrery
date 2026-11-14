<script setup lang="ts">
// A tab's title starts with the workspace it's in when that isn't the default one (ORR-1108), so tabs in different
// workspaces tell apart. The workspace took the place of the orrery's environment name (ORR-1193).
const {current} = useWorkspaces()
useHead(() => {
    const workspace = current.value && current.value.id !== 'default' ? current.value.name : null
    return {titleTemplate: (title?: string) => [workspace, title ?? 'orrery'].filter(Boolean).join(' · ')}
})
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
