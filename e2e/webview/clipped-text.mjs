/**
 * Text cut off on screen (design system, 2026-11-24: Query's Columns read "ed" for "Not used" and "ntityAllocated"
 * at every width, and the band checks, which measured boxes, still passed). For the specs that check a layout:
 *
 *   import { clippedText } from './clipped-text.mjs';
 *   expect(await clippedText(page, '.query-page')).toEqual([]);
 *
 * Every text under the root that is shown, with the side it is cut on and by how much: past the window, or past
 * an ancestor that clips (overflow hidden or clip). Not counted: text that ends in an ellipsis on purpose
 * (text-overflow: ellipsis on the way up: its whole text is on hover), and text running on past the right of a
 * box that scrolls (it is reached by scrolling). Text before the left of a scrolling box is counted: no scroll
 * reaches it.
 */
export const clippedText = (page, root = 'body') => page.evaluate(sel => {
    const out = [];
    const top = document.querySelector(sel);
    if (!top) return out;
    const vw = document.documentElement.clientWidth;
    const walker = document.createTreeWalker(top, NodeFilter.SHOW_TEXT, { acceptNode: n => (n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement;
        if (!el || !el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const t = range.getBoundingClientRect();
        if (!t.width || !t.height) continue;
        let left = 0, right = vw, meant = false, rightReachable = false;
        for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
            const s = getComputedStyle(a);
            if (s.textOverflow === 'ellipsis') { meant = true; break; }
            if (s.overflowX === 'visible') continue;
            const b = a.getBoundingClientRect();
            left = Math.max(left, b.left);
            if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && t.right > b.right) rightReachable = true;
            else right = Math.min(right, b.right);
        }
        if (meant) continue;
        const text = n.textContent.trim().slice(0, 40);
        if (t.left < left - 1) out.push({ text, side: 'left', by: Math.round(left - t.left) });
        else if (!rightReachable && t.right > right + 1) out.push({ text, side: 'right', by: Math.round(t.right - right) });
    }
    return out;
}, root);
