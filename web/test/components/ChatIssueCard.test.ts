import {mountSuspended} from '@nuxt/test-utils/runtime'
import {describe, expect, it} from 'vitest'
import ChatIssueCard from '~/components/ChatIssueCard.vue'

// The issue the chat offers (ORR-711): plainly not filed until the owner presses File issue.
const props = (request: Record<string, unknown>, ended = false) => ({request: {title: 'Fix the vent', state: 'asked', ...request}, project: 'greenhouse', busy: false, ended})

describe('ChatIssueCard', () => {
    it('reads as not filed, shows what it would file as written, and asks', async () => {
        const card = await mountSuspended(ChatIssueCard, {props: props({notes: '**It sticks.**', priority: 'P2', labels: ['bug']})})
        expect(card.text()).toContain('nothing is filed yet')
        expect(card.text()).toContain('Fix the vent')
        expect(card.text()).toContain('P2 · bug')
        expect(card.text()).toContain('**It sticks.**')
        const [file, skip] = card.findAll('button')
        expect(file!.text()).toBe('File issue')
        expect(skip!.text()).toBe("Don't file")
        await file!.trigger('click')
        await skip!.trigger('click')
        expect(card.emitted('decide')).toEqual([[true], [false]])
    })

    it('links to what it became', async () => {
        const card = await mountSuspended(ChatIssueCard, {props: props({state: 'allowed', id: 'GRE-9'})})
        expect(card.findAll('button')).toHaveLength(0)
        expect(card.text()).toContain('Filed as GRE-9')
        expect(card.find('a').attributes('href')).toBe('/p/greenhouse/issues/GRE-9')
    })

    it('says nothing was filed when it was left, expired, or the chat ended', async () => {
        expect((await mountSuspended(ChatIssueCard, {props: props({state: 'denied'})})).text()).toContain('Not filed: you said not to')
        expect((await mountSuspended(ChatIssueCard, {props: props({state: 'expired'})})).text()).toContain('Not filed: not answered in time')
        const ended = await mountSuspended(ChatIssueCard, {props: props({}, true)})
        expect(ended.text()).toContain('Not filed')
        expect(ended.findAll('button')).toHaveLength(0)
    })
})
