// The tab's icon in a workspace's colour (ORR-1104): public/favicon.svg's mark on a tile of that colour, shaded
// towards its lower corner as the logo's own orange is, so tabs in different workspaces tell apart at a glance.

/** The logo with its tile in `color` (a CSS colour), as an SVG document. */
export function faviconSvg(color: string): string {
    const fill = color.replace(/[^#a-zA-Z0-9(),.%\s-]/g, '')
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800">'
        + '<defs><linearGradient id="s" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".28"/></linearGradient></defs>'
        + `<rect width="800" height="800" rx="176" fill="${fill}"/><rect width="800" height="800" rx="176" fill="url(#s)"/>`
        + '<g transform="translate(400 400)" fill="#FFFFFF"><g transform="rotate(-25)"><path d="M213.1 -73.4A260 128 0 1 1 45.7 -126" fill="none" stroke="#FFFFFF" stroke-width="40" stroke-linecap="round"/><circle cx="140" cy="-107.9" r="50"/></g><circle r="64"/></g></svg>'
}

/** `faviconSvg(color)` as a `data:` address for a `<link rel="icon">`. */
export function faviconHref(color: string): string {
    return `data:image/svg+xml,${encodeURIComponent(faviconSvg(color))}`
}
