<script setup lang="ts">
import type {PermissionLevel, SessionKind} from '#shared/permissions'
import {PERMISSION_LEVELS, PERMISSIONS, SESSION_KINDS, areaId, permissionAreas} from '#shared/permissions'

// What a session may do, read-only (ORR-459): the server's own table (shared/permissions.ts), which a test holds to what
// it enforces, by area, each thing against a working session, the owner's chat and an untrusted session.
const kinds = Object.entries(SESSION_KINDS) as [SessionKind, string][]
const areas = permissionAreas().map(area => ({area, rows: PERMISSIONS.filter(p => p.area === area)}))

/** Each level's colour: free in green, asks in amber, runs once it's yours in violet, the owner's and refused quiet. */
const TONE: Record<PermissionLevel, string> = {
    free: 'text-emerald-700 dark:text-emerald-400',
    limited: 'text-emerald-700 dark:text-emerald-400',
    asks: 'text-amber-800 dark:text-amber-400',
    owned: 'text-violet-700 dark:text-violet-400',
    owner: 'text-fg',
    refused: 'text-faint',
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <p class="text-xs leading-relaxed text-muted">
      What each kind of session may do here, as orrery enforces it. <strong class="font-medium text-fg">Asks you</strong> waits for
      your Allow or Send; <strong class="font-medium text-fg">Owner only</strong> is a 403 for any agent. Agents read the same table
      at <code class="font-mono text-[11px]">/api/permissions</code>, so they ask rather than try. Why each is so is under it, and the
      <a href="https://github.com/steffendybvik/orrery/blob/main/SECURITY.md" target="_blank" rel="noopener" class="underline underline-offset-2 hover:text-fg">security notes</a>
      say more.
    </p>
    <section v-for="{area, rows} in areas" :id="areaId(area)" :key="area" class="flex scroll-mt-14 flex-col gap-2">
      <h2 class="text-[15px] font-semibold text-fg">{{ area }}</h2>
      <div class="overflow-x-auto rounded-xl border border-line dark:bg-panel">
        <table class="w-full min-w-[40rem] table-fixed text-left text-xs">
          <thead class="bg-panel text-[11px] text-muted dark:bg-hover">
            <tr>
              <th class="w-2/5 px-3 py-2 font-medium" />
              <th v-for="[kind, label] in kinds" :key="kind" class="w-1/5 px-3 py-2 font-medium">{{ label }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in rows" :key="p.id" :data-permission="p.id" class="border-t border-line align-top">
              <td class="px-3 py-2.5">
                <p class="font-medium text-fg">{{ p.action }}</p>
                <p class="mt-0.5 leading-relaxed text-muted">{{ p.why }}</p>
              </td>
              <td v-for="[kind] in kinds" :key="kind" class="px-3 py-2.5">
                <p class="font-medium" :class="TONE[p[kind].level]">{{ PERMISSION_LEVELS[p[kind].level] }}</p>
                <p v-if="p[kind].note" class="mt-0.5 leading-relaxed text-faint">{{ p[kind].note }}</p>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
