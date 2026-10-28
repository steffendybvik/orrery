// What `pnpm docs:sync` copies into a project's docs, and how a file's links are pointed when it's there (ORR-296).
import {dirname, posix} from 'node:path'

/** The repo's files a project's docs copy, each to the doc id it's kept under. */
export const SYNCED: Record<string, string> = {
    'README.md': 'readme',
    'CHANGELOG.md': 'changelog',
    'CONTRIBUTING.md': 'contributing',
    'SECURITY.md': 'security',
    'docs/API.md': 'api',
    'docs/components.md': 'components',
    'docs/connect.md': 'connect',
    'docs/development.md': 'development',
    'docs/running.md': 'running',
    'docs/using.md': 'using',
}

/** A doc's title: its file's first `# ` heading, or else the file's name. */
export function titleOf(body: string, file: string): string {
    return body.match(/^# (.+)$/m)?.[1]?.trim() ?? posix.basename(file, '.md')
}

/** The file's links and images to other files in the repo, each passed to `to` by its path from the repo's root (an
 * image with `image` set): what it returns goes in its place, the `#part` kept; null leaves the link as written. Links
 * to the web, to a part of the same page or from the site's root, and anything in a fenced code block, stay as they are. */
export function pointLinks(body: string, file: string, to: (path: string, image: boolean) => string | null): string {
    const point = (target: string, image: boolean) => {
        if (/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) return target
        const [path = '', part] = target.split('#', 2)
        const resolved = posix.normalize(posix.join(dirname(file), decodeURI(path)))
        if (!path || resolved.startsWith('..')) return target
        const pointed = to(resolved, image)
        return pointed === null ? target : `${pointed}${part === undefined ? '' : `#${part}`}`
    }
    return body.split(/^(```[^\n]*\n[\s\S]*?^```[ \t]*$)/m).map((piece, i) => i % 2 ? piece : piece
        .replace(/(!?)(\[[^\]\n]*\]\()([^)\s]+)(\))/g, (_, bang: string, open: string, target: string, close: string) => `${bang}${open}${point(target, !!bang)}${close}`)
        .replace(/(<img\b[^>]*?\bsrc=")([^"]+)(")/g, (_, open: string, target: string, close: string) => `${open}${point(target, true)}${close}`))
        .join('')
}
