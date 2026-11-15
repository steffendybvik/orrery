<script setup lang="ts">
// A tab's title starts with the workspace it's in when that isn't the default one (ORR-1108), so tabs in different
// workspaces tell apart. The workspace took the place of the orrery's environment name (ORR-1193).
// Its icon takes the workspace's colour, when it has one (ORR-1104): both icon links, so no browser keeps the orange.
const {current} = useWorkspaces()
useHead(() => {
    const workspace = current.value && current.value.id !== 'default' ? current.value.name : null
    const color = workspaceColor(current.value?.color)
    const href = color ? faviconHref(color) : null
    return {
        titleTemplate: (title?: string) => [workspace, title ?? 'orrery'].filter(Boolean).join(' · '),
        link: href ? [{key: 'icon', rel: 'icon', type: 'image/svg+xml', href}, {key: 'icon-svg', rel: 'icon', type: 'image/svg+xml', href}] : [],
    }
})
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
