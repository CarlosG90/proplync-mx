/**
 * PropLync Mini · business types for the functions
 * -----------------------------------------------------------------------------
 * WHY THIS FILE
 * The templates live once, in mini/js/business-types.js, a classic script the
 * browser pages load with <script src>. Importing it here runs it (it sets
 * globalThis.MINI_TYPES) and the static import makes Vercel bundle it with every
 * function that imports this file.
 * -----------------------------------------------------------------------------
 */
import '../js/business-types.js';

const T = globalThis.MINI_TYPES;
export const BUSINESS_TYPES = T.TYPES;
export const BUSINESS_TYPE_KEYS = T.KEYS;
export const typeFor = T.typeFor;
