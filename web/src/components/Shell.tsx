import Link from "next/link";

export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5 font-semibold tracking-tight" aria-label="Unlisted home">
      <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden>
        <rect x="1" y="1" width="24" height="24" rx="7" fill="#0E1116" />
        <path d="M7 9h12M7 13h7M7 17h4" stroke="#F6F4EF" strokeWidth="2" strokeLinecap="round" />
        <path d="M5 21 21 5" stroke="#E8A317" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
      <span className="text-[17px]">Unlisted</span>
    </Link>
  );
}

export function SiteHeader() {
  return (
    <header className="border-b border-ink/10 bg-paper/80 backdrop-blur supports-[backdrop-filter]:bg-paper/70">
      <div className="mx-auto flex h-16 max-w-page items-center justify-between px-4 sm:px-6">
        <Logo />
        <nav className="flex items-center gap-1 text-sm">
          <Link href="/how-it-works" className="btn-ghost hidden sm:inline-flex">
            How it works
          </Link>
          <Link href="/privacy" className="btn-ghost hidden sm:inline-flex">
            Threat model
          </Link>
          <Link href="/new" className="btn-primary ml-1">
            Create an event
          </Link>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-ink/10">
      <div className="mx-auto flex max-w-page flex-col gap-4 px-4 py-10 text-sm text-ink-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex items-center gap-3">
          <Logo />
          <span>RSVPs without a guest list. Built on shielded Zcash.</span>
        </div>
        <div className="flex gap-5">
          <Link href="/how-it-works" className="hover:text-ink">How it works</Link>
          <Link href="/privacy" className="hover:text-ink">Threat model</Link>
          <a href="https://github.com/linoxbt/cashr" className="hover:text-ink">Source</a>
        </div>
      </div>
    </footer>
  );
}
