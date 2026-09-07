/**
 * Types for the branding release gate, so its contract can be asserted from
 * the TypeScript test suite (tests/brandingGate.test.ts) without turning on
 * `allowJs` for every script in the repo.
 */
export declare const LEGACY_PRODUCT_PATTERNS: readonly string[];
export declare const PRODUCT_NAME: string;
export declare const PRODUCT_TAGLINE: string;
export declare const ALLOWED: readonly {
  file: string;
  text: string;
  reason: string;
}[];
export declare function isCommentLine(line: string, ext: string): boolean;
