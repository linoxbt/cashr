"use client";

// Any page that fails to render lands here, inside the usual frame, instead of a
// blank "Application error". Nothing about the failure is sent anywhere.
export default function PageError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto max-w-lg px-4 py-24 text-center">
      <p className="eyebrow">Something broke</p>
      <h1 className="mt-3 text-2xl">This page hit an error</h1>
      <p className="mt-3 text-sm text-ink-3">
        Your tickets and links on this device are untouched. Try again, or go home and open the link once more.
      </p>
      <div className="mt-6 flex justify-center gap-3">
        <button className="btn-primary" onClick={reset}>Try again</button>
        {/* A full page load on purpose: the app's own state may be what broke. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/" className="btn-secondary">Go home</a>
      </div>
    </div>
  );
}
