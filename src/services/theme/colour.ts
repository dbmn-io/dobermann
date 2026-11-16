// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Colour arithmetic for themes (#373): Omarchy's `mix` (omarchy-theme-color) and WCAG contrast
 * for the tests that keep every bundled theme readable. Hex in, hex out.
 */
type Rgb = [number, number, number];

function rgb(hex: string): Rgb {
    const value = hex.replace('#', '');
    return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}
function hex([r, g, b]: Rgb): string {
    return '#' + [r, g, b].map(channel => Math.round(Math.max(0, Math.min(255, channel))).toString(16).padStart(2, '0')).join('');
}

/** `amount` of `top` over `base` (0 is base, 1 is top), rounded as Omarchy's mix_color rounds. */
export function mix(base: string, top: string, amount: number): string {
    const a = rgb(base);
    const b = rgb(top);
    return hex([a[0] * (1 - amount) + b[0] * amount, a[1] * (1 - amount) + b[1] * amount, a[2] * (1 - amount) + b[2] * amount]);
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(colour: string): number {
    const [r, g, b] = rgb(colour).map(channel => {
        const c = channel / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
