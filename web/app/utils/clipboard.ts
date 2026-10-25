/** Copies text, falling back to a hidden text field where the clipboard API refuses. Says whether it worked. */
export async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text)
        return true
    } catch {
        const field = document.createElement('textarea')
        field.value = text
        field.setAttribute('readonly', '')
        field.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
        document.body.append(field)
        field.select()
        const done = document.execCommand('copy')
        field.remove()
        return done
    }
}
