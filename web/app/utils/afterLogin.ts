/** What a signed-in page does with the page kept from before logging in (ORR-1192), `back`, when it's at `here`: the
 * key is cleared whenever it's found, as one left behind would send a later load in the tab to it (ORR-1227), and the
 * page goes there only when it's somewhere else. */
export function afterLogin(back: string | null, here: string): {clear: boolean, go?: string} {
    if (!back) return {clear: false}
    return back === here ? {clear: true} : {clear: true, go: back}
}
