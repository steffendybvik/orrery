<script setup lang="ts">
import {renderSVG} from 'uqr'
import type {PhoneAddress, PhoneLinks} from '#shared/phone'

// Open on your phone (ORR-833), on App settings → You: orrery's address on the network with Copy and a QR code, for opening
// it on a phone the first time, so a scan and a sign-in are all it takes. The code is drawn here, by `uqr`, with nothing
// sent anywhere. While only this machine can reach it, it says how to give the phone a port of its own.
// With the phone's own port (ORR-837), the code carries a one-time sign-in link instead: scanned, the phone is signed in,
// nothing to type. A fresh one is made each time this shows, and again as it runs out.
const links = ref<PhoneLinks | null>(null)
const failed = ref('')
const chosen = ref('')
const token = ref('')
let renew: ReturnType<typeof setTimeout> | undefined
/** A fresh one-time sign-in link, and another a little before it runs out. */
async function signInLink() {
    clearTimeout(renew)
    try {
        const made = await apiFetch<{token: string, expires_at: string}>('/phone/link', {method: 'POST'})
        token.value = made.token
        renew = setTimeout(signInLink, Math.max(new Date(made.expires_at).getTime() - Date.now() - 30_000, 10_000))
    } catch (error) {
        failed.value = errorMessage(error)
    }
}
onMounted(async () => {
    try {
        links.value = await apiFetch<PhoneLinks>('/phone')
        chosen.value = links.value.addresses[0]?.url ?? ''
        if (links.value.phone && links.value.reach === 'network') await signInLink()
    } catch (error) {
        failed.value = errorMessage(error)
    }
})
onBeforeUnmount(() => clearTimeout(renew))

const open = computed(() => links.value?.reach === 'network')
/** What the code opens: the address, signing the phone in with a one-time link when it has its own port. */
const target = computed(() => chosen.value && links.value?.phone && token.value ? `${chosen.value}/login?t=${token.value}` : chosen.value)
const qr = computed(() => target.value ? renderSVG(target.value, {border: 2, pixelSize: 4, whiteColor: '#fff', blackColor: '#000'}) : '')
const SOURCES: Record<PhoneAddress['from'], string> = {
    setting: 'ORRERY_PHONE_URL',
    host: 'ORRERY_HOST',
    machine: "this machine's network",
    launcher: '',
}
const sourceOf = (address: PhoneAddress) => address.from === 'launcher' ? `the launcher on ${address.machine || 'this machine'}` : SOURCES[address.from]
</script>

<template>
  <div class="flex flex-col gap-3 text-xs">
    <p v-if="failed" class="text-rose-700 dark:text-rose-400">{{ failed }}</p>
    <template v-else-if="links && open">
      <div v-if="links.addresses.length" class="flex flex-wrap items-start gap-4">
        <!-- White behind it in dark mode too, as a camera reads dark on light. -->
        <!-- eslint-disable-next-line vue/no-v-html -- uqr's own SVG of rects, of an address orrery made -->
        <div class="size-40 shrink-0 rounded-lg bg-white p-1 [&>svg]:size-full" role="img" :aria-label="`QR code for ${chosen}`" v-html="qr" />
        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <ul class="flex flex-col gap-1">
            <li v-for="address in links.addresses" :key="address.url" class="flex flex-wrap items-center gap-2">
              <button
                  type="button"
                  class="rounded-md px-1.5 py-0.5 font-mono text-[13px]"
                  :class="address.url === chosen ? 'bg-hover text-fg' : 'text-muted hover:text-fg'"
                  :aria-pressed="address.url === chosen"
                  :aria-label="`Show the QR code for ${address.url}`"
                  @click="chosen = address.url"
              >{{ address.url }}</button>
              <span class="text-faint">from {{ sourceOf(address) }}</span>
              <CopyButton :text="address.url" compact />
            </li>
          </ul>
          <p v-if="links.phone" class="text-muted">
            Scan it with the phone's camera and you're signed in, on a login of the phone's own. The code works once, for
            5 minutes, and a new one shows here as it runs out. The address alone asks for a login.
          </p>
          <p v-else class="text-muted">
            Scan it with the phone's camera, then sign in with your person key.
          </p>
          <p v-if="chosen.startsWith('http://')" class="text-amber-800 dark:text-amber-300">
            This is plain http. Over a VPN that's encrypted, but over Wi-Fi your person key and the login's cookie travel
            unencrypted, so anyone else on it could read them.
          </p>
        </div>
      </div>
      <p v-else class="text-muted">
        orrery is open to the network, but it can't see this machine's address from inside its container. Start the
        launcher (Sessions → Setup) and it says, or set <code class="font-mono">ORRERY_PHONE_URL=http://&lt;address&gt;:{{ links.port || '9000' }}</code>.
      </p>
    </template>
    <template v-else-if="links">
      <p v-if="links.phone" class="text-muted">
        The phone's port is on this machine only (<code class="font-mono">ORRERY_PHONE_HOST</code> is loopback). Remove it
        from <code class="font-mono">.env</code> and run <code class="font-mono">docker compose up -d</code>, and this shows a
        code that signs your phone in. The sessions' address stays as it is.
      </p>
      <p v-else class="text-muted">
        Only this machine can open it now. Start orrery with <code class="font-mono">ORRERY_PHONE_PORT</code> set (Docker sets
        one already), and this shows a code that signs your phone in. The sessions' address stays as it is.
      </p>
      <p class="text-faint">
        More in Running orrery, under <a href="/p/orrery/docs/running#reach-it-from-your-phone" class="underline">Reach it from your phone</a>.
      </p>
    </template>
  </div>
</template>
