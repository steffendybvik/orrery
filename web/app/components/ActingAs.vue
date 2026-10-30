<script setup lang="ts">
// Who this browser acts as (ORR-657), with more than one person and login off. It's for trying people out on one machine.
const {here, me, picks, actAs} = usePeople()
</script>

<template>
  <label v-if="picks" class="mt-1.5 flex flex-col gap-1 px-2 text-[11px] text-muted" title="These are names, not passwords: anyone who can reach this orrery can say they're anyone">
    <span>Acting as <span class="text-faint">(a name, not a login)</span></span>
    <select class="h-7 field text-xs" aria-label="Acting as" :value="me ?? ''" @change="actAs(($event.target as HTMLSelectElement).value)">
      <option v-for="person in here" :key="person.id" :value="person.id">{{ person.name }}</option>
    </select>
  </label>
</template>
