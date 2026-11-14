<script setup lang="ts">
// Every tab's title starts with which orrery this is (personal, work, …), and the workspace it's in when that isn't
// the default one (ORR-1108), so tabs in different workspaces tell apart.
const {environment} = useRuntimeConfig().public
const {current} = useWorkspaces()
useHead(() => {
    const workspace = current.value && current.value.id !== 'default' ? current.value.name : null
    return {titleTemplate: (title?: string) => [environment, workspace, title ?? 'orrery'].filter(Boolean).join(' · ')}
})
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
