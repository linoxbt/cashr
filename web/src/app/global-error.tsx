"use client";

// The last resort, when even the frame around every page fails: it replaces the
// root layout, so it brings its own document and plain styles.
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", background: "#050505", color: "#e8e4da", fontFamily: "system-ui, sans-serif", textAlign: "center", padding: "1rem" }}>
        <div>
          <h1 style={{ fontSize: "1.5rem", fontWeight: 600 }}>cashr hit an error</h1>
          <p style={{ opacity: 0.7, fontSize: "0.9rem" }}>Your tickets and links on this device are untouched.</p>
          <p>
            <button onClick={reset} style={{ marginRight: "0.75rem" }}>Try again</button>
            {/* A full page load on purpose: the app's own state may be what broke. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" style={{ color: "inherit" }}>Go home</a>
          </p>
        </div>
      </body>
    </html>
  );
}
