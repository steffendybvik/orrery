import type {Locator, Page} from '@playwright/test'
import {expect, test} from '@playwright/test'

// Every piece of the kit on /ui (dev only), from the mouse and the keyboard: the Headless UI parts (Dialog,
// Combobox, Listbox, Menu, RadioGroup) and our own (UiButton, UiConfirm, UiContextMenu).
const last = (page: Page) => page.getByRole('status')
// Headless UI lights an option a frame after a key; a person can't press ↵ inside one.
const lit = (within: Locator | Page, name: RegExp) => expect(within.locator('[data-headlessui-state~=active]').filter({hasText: name})).toHaveCount(1)

test.beforeEach(async ({page}) => {
    await page.goto('/ui')
    await expect(page.getByRole('heading', {name: 'UI kit'})).toBeVisible()
})

test('UiButton: every variant at every size', async ({page}) => {
    for (const variant of ['primary', 'secondary', 'ghost', 'danger', 'danger-outline', 'danger-ghost', 'success', 'success-outline', 'warning-outline'])
        await expect(page.getByRole('button', {name: variant, exact: true})).toHaveCount(3)
})

test('everything you can click shows the pointer, a disabled button the arrow', async ({page}) => {
    const cursor = (target: Locator) => target.evaluate(el => getComputedStyle(el).cursor)
    expect(await cursor(page.getByRole('button', {name: 'primary', exact: true}).first())).toBe('pointer')
    expect(await cursor(page.getByRole('radio', {name: /Board/}))).toBe('pointer')
    await page.getByRole('button', {name: 'Status', exact: true}).click()
    expect(await cursor(page.getByRole('option').first())).toBe('pointer')
    await page.keyboard.press('Escape')
    await page.getByRole('button', {name: 'primary', exact: true}).first().evaluate(el => (el as HTMLButtonElement).disabled = true)
    expect(await cursor(page.getByRole('button', {name: 'primary', exact: true}).first())).toBe('default')
})

test('PropertyPicker: types to narrow, ↵ picks, and the focus comes back', async ({page}) => {
    const status = page.getByRole('button', {name: 'Status', exact: true})
    await status.click()
    await page.keyboard.type('pro')
    await lit(page, /In progress/)
    await page.keyboard.press('Enter')
    await expect(page.getByRole('listbox')).toBeHidden()
    await expect(status).toHaveText(/In progress/)
    await expect(status).toBeFocused()

    // Esc closes without a pick; a press outside too.
    await page.keyboard.press('Enter')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Escape')
    await expect(status).toHaveText(/In progress/)
    await status.click()
    await page.getByRole('heading', {name: 'UI kit'}).click()
    await expect(page.getByRole('listbox')).toBeHidden()
})

test('PropertyPicker, multiple and creatable: ticks many, makes one, stays open', async ({page}) => {
    const labels = page.getByRole('button', {name: 'Labels', exact: true})
    await labels.click()
    await page.keyboard.type('urgent')
    await lit(page, /Add/)
    await page.keyboard.press('Enter')
    await expect(page.getByRole('option', {name: 'urgent', exact: true})).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('option', {name: 'design', exact: true}).click()
    await expect(page.getByRole('option', {name: 'design', exact: true})).toHaveAttribute('aria-selected', 'false')
    await page.keyboard.press('Escape')
    await expect(labels).toContainText('urgent')
    await expect(labels).not.toContainText('design')
})

test('PropertyPicker as a field: Tab reaches it, ↓ opens it', async ({page}) => {
    const small = page.getByRole('button', {name: 'Small status'})
    await small.focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('listbox')).toBeVisible()
    await page.keyboard.type('done')
    await lit(page, /Done/)
    await page.keyboard.press('Enter')
    await expect(small).toHaveText('Done')
    await expect(page.getByRole('button', {name: 'Status', exact: true})).toHaveText(/Done/)
    await expect(page.getByRole('button', {name: 'Priority', exact: true})).toHaveAttribute('tabindex', '0')
})

test('FilterMenu: ticks from the keys, counts them, Clear and Esc', async ({page}) => {
    const filter = page.getByRole('button', {name: /^Urgency/})
    // With nothing ticked it opens on its first option.
    await filter.focus()
    await page.keyboard.press('Enter')
    const list = page.getByRole('listbox')
    await lit(list, /Urgent/)
    await page.keyboard.press(' ')
    await page.keyboard.press('ArrowDown')
    await lit(list, /High/)
    await page.keyboard.press('Enter')
    // Many can be ticked, so it stays open.
    await expect(list).toBeVisible()
    await expect(filter).toHaveText(/Urgency · 2/)
    await page.keyboard.press('Escape')
    await expect(list).toBeHidden()
    await expect(filter).toBeFocused()
    await filter.click()
    await page.getByRole('button', {name: 'Clear'}).click()
    await expect(filter).toHaveText(/^\s*Urgency\s*$/)
})

test('Menu: ↵ opens it on its first line, ↓ moves, ↵ runs, Esc closes', async ({page}) => {
    const button = page.getByRole('button', {name: 'A menu'})
    await button.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu')
    await expect(menu.getByRole('menuitem')).toHaveText(['Copy id', 'Open', 'Remove…'])
    await lit(menu, /Copy id/)
    await page.keyboard.press('ArrowDown')
    await lit(menu, /Open/)
    await page.keyboard.press('Enter')
    await expect(menu).toBeHidden()
    await expect(last(page)).toHaveText('Last: Open')
    await expect(button).toBeFocused()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
})

test('UiContextMenu: opens at the pointer, takes the focus, and Esc, a press outside or a pick closes it', async ({page}) => {
    const area = page.getByText('Right-click here')
    const menu = page.getByRole('menu', {name: 'Example menu'})
    const at = (await area.boundingBox())!
    const [x, y] = [at.x + 10, at.y + 10]
    await page.mouse.click(x, y, {button: 'right'})
    await expect(menu).toBeVisible()
    await expect(menu).toBeFocused()
    // Where it's placed, not where it is mid fade-in.
    const [left, top] = await menu.evaluate(m => [parseFloat(m.style.left), parseFloat(m.style.top)])
    expect(Math.abs(left! - x)).toBeLessThanOrEqual(1)
    expect(Math.abs(top! - y)).toBeLessThanOrEqual(1)
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()

    await area.click({button: 'right'})
    await page.getByRole('heading', {name: 'UI kit'}).click()
    await expect(menu).toBeHidden()

    await area.click({button: 'right'})
    await menu.getByRole('button', {name: 'Copy id'}).click()
    await expect(menu).toBeHidden()
    await expect(last(page)).toHaveText('Last: Copy id')
})

test('SegmentedControl: one choice, a click or ←→ moves it', async ({page}) => {
    const [list, board] = [page.getByRole('radio', {name: 'List'}), page.getByRole('radio', {name: 'Board'})]
    await expect(list).toHaveAttribute('aria-checked', 'true')
    await board.click()
    await expect(board).toHaveAttribute('aria-checked', 'true')
    await expect(list).toHaveAttribute('aria-checked', 'false')
    await page.keyboard.press('ArrowLeft')
    await expect(list).toHaveAttribute('aria-checked', 'true')
    await expect(list).toBeFocused()
})

test('UiDialog: keeps the focus inside, closes on Esc or a press outside, submits on ↵', async ({page}) => {
    const open = page.getByRole('button', {name: 'Open a dialog'})
    const dialog = page.getByRole('dialog', {name: 'Example dialog'})
    await open.click()
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('Something to say')).toBeFocused()
    // Tab goes round the dialog's own controls, never out to the page under it.
    for (let i = 0; i < 4; i++) {
        await page.keyboard.press('Tab')
        expect(await dialog.evaluate(d => d.contains(document.activeElement))).toBe(true)
    }
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(open).toBeFocused()

    await open.click()
    await page.mouse.click(5, 5)
    await expect(dialog).toBeHidden()

    await open.click()
    await dialog.getByLabel('Something to say').fill('hello')
    await page.keyboard.press('Enter')
    await expect(dialog).toBeHidden()
    await expect(last(page)).toHaveText('Last: Submitted hello')
})

test('UiConfirm: asks in place, Cancel goes back, Remove does it', async ({page}) => {
    await page.getByRole('button', {name: 'Remove…'}).click()
    await expect(page.getByText('Remove this example?')).toBeVisible()
    await page.getByRole('button', {name: 'Cancel'}).click()
    await expect(page.getByText('Remove this example?')).toBeHidden()
    await page.getByRole('button', {name: 'Remove…'}).click()
    await page.getByRole('button', {name: 'Remove', exact: true}).click()
    await expect(last(page)).toHaveText('Last: Removed')
})
