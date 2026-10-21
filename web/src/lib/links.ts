/**
 * Where a pasted link should go. Accepts a full event, manage or door link (its
 * #k= token is kept), or a bare 10-character event code. Event links drop any
 * fragment: an invite never carries a secret.
 */
export function linkTarget(input: string): string | null {
  const text = input.trim();
  if (/^[a-z0-9]{10}$/.test(text)) return `/e/${text}`;
  try {
    const url = new URL(text, "https://x.invalid");
    const m = url.pathname.match(/^\/(e|manage|door)\/([a-z0-9]{10})\/?$/);
    if (!m) return null;
    return `/${m[1]}/${m[2]}${m[1] === "e" ? "" : url.hash}`;
  } catch {
    return null;
  }
}
