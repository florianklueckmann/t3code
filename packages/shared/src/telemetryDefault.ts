/**
 * Fork default: nothing goes to T3's services (product events, relay traces, mobile crash
 * reports) until `T3CODE_TELEMETRY_ENABLED=true` or the mobile crash report switch turns it on.
 * Imports nothing, so web and mobile bundles can read it. Typed `boolean` so readers keep both
 * branches.
 */
export const TELEMETRY_ENABLED_BY_DEFAULT: boolean = false;
