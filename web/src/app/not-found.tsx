import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg px-4 py-24 text-center">
      <p className="eyebrow">404</p>
      <h1 className="mt-3 text-2xl ">This page isn&rsquo;t here</h1>
      <p className="mt-3 text-sm text-ink-3">If you were sent an event link, check it was copied in full.</p>
      <Link href="/" className="btn-primary mt-6">Go home</Link>
    </div>
  );
}
