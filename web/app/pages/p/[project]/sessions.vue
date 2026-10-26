<script setup lang="ts">
// A project's sessions are on the Sessions page now, kept to the project: an old link comes here and goes on there.
const route = useRoute()
await navigateTo({path: '/sessions', query: {project: route.params.project as string}, hash: route.hash}, {replace: true})
</script>

<template>
  <div />
</template>
