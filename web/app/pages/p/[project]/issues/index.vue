<script setup lang="ts">
// An issue is at /p/<project>/issues/<id>, so cutting the id off a link is a way back to the list: it goes on to the board (ORR-1156).
const route = useRoute()
await navigateTo({path: `/p/${route.params.project as string}`, hash: route.hash}, {replace: true})
</script>

<template>
  <div />
</template>
