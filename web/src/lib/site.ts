// Where the real app and the no-ZEC demo live. The demo is the same app built
// against a server on a simulated chain.
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://cashr.site").replace(/\/$/, "");
export const DEMO_URL = (process.env.NEXT_PUBLIC_DEMO_URL || "https://demo.cashr.site").replace(/\/$/, "");
// Set when building the demo site, so its banner is there from the first paint
// instead of appearing (and shifting the page) once the server says "simulated".
export const IS_DEMO_BUILD = process.env.NEXT_PUBLIC_DEMO === "1";
