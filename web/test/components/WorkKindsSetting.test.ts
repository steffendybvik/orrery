import {describe, expect, it, vi} from 'vitest'
import {mountSuspended, registerEndpoint} from '@nuxt/test-utils/runtime'
import {readBody} from 'h3'
import {WORK_KINDS} from '#shared/roadmap'
import WorkKindsSetting from '~/components/WorkKindsSetting.vue'

/** Waits for the page's next save, and gives what it sent. */
async function nextSave<T>(before: number): Promise<T> {
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(before))
    return sent.at(-1) as T
}

// What the page sent as work_kinds, each change in turn (ORR-869).
const sent: unknown[] = []
registerEndpoint('/api/owner', () => ({name: 'skoll', display: 'Sköll', named: true}))
registerEndpoint('/api/settings', {method: 'PATCH', handler: async event => {
    const body = await readBody<{work_kinds: unknown}>(event)
    sent.push(body.work_kinds)
    return {...useAppSettings().settings.value, work_kinds: body.work_kinds ?? WORK_KINDS}
}})

describe('WorkKindsSetting (ORR-869)', () => {
    it("lists orrery's kinds in rank, and saves a kind's model, its order and a new one", async () => {
        sent.length = 0
        const page = await mountSuspended(WorkKindsSetting)
        expect(page.findAll('li').map(li => li.attributes('data-kind'))).toEqual(WORK_KINDS.map(k => k.id))
        const docs = page.find('li[data-kind="docs"]')
        await docs.find('input[aria-label="Docs\'s model"]').setValue('haiku')
        await docs.find('input[aria-label="Docs\'s model"]').trigger('change')
        expect((await nextSave<{id: string, model: string}[]>(0)).find(k => k.id === 'docs')?.model).toBe('haiku')
        let count = sent.length
        await page.find('button[aria-label="Move Docs up"]').trigger('click')
        const order = (await nextSave<{id: string}[]>(count)).map(k => k.id)
        expect(order.indexOf('docs')).toBeLessThan(order.indexOf('maintenance'))
        await page.find('input[aria-label="A new kind\'s name"]').setValue('Design')
        count = sent.length
        await page.find('form').trigger('submit')
        const added = await nextSave<{id: string, labels: string[]}[]>(count)
        expect(added[added.findIndex(k => k.id === 'other') - 1]).toMatchObject({id: 'design', labels: ['design'], model: 'best'})
    })

    it('refuses a model orrery doesn\'t take without saving, and resets to orrery\'s own with null', async () => {
        sent.length = 0
        const page = await mountSuspended(WorkKindsSetting)
        const model = page.find('li[data-kind="bug"] input[aria-label="Bug\'s model"]')
        await model.setValue('gpt')
        await model.trigger('change')
        expect(sent).toEqual([])
        expect(page.text()).toContain("Bug's model should be")
        await model.setValue('sonnet')
        await model.trigger('change')
        await nextSave(0)
        const reset = page.findAll('button').find(b => b.text() === "Reset to orrery's defaults")
        const before = sent.length
        await reset!.trigger('click')
        expect(await nextSave(before)).toBeNull()
    })
})
