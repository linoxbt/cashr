"use client";

import Link from "next/link";

import { Channel, MyEvents, MyTickets, OpenLink, ServerStatus } from "@/components/console";

export default function Console() {
  return (
    <div className="mx-auto max-w-page px-4 sm:px-8">
      <div className="flex flex-col gap-6 border-b border-ink/10 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-5xl leading-[0.95] sm:text-6xl">RSVPs without a guest list.</h1>
          <p className="mt-3 max-w-xl text-ink-2">
            Refundable shielded-ZEC deposits stop no-shows. Nobody, not even the organiser, ever holds a list of who came.{" "}
            <Link href="/docs" className="whitespace-nowrap text-ink underline decoration-gold decoration-2 underline-offset-4">
              Read the docs
            </Link>
          </p>
        </div>
        <ServerStatus />
      </div>

      <div className="mt-6 grid gap-5 md:grid-cols-2">
        <Channel n="01" title="Host an event">
          <p className="text-sm leading-relaxed text-ink-2">
            Set a refundable deposit and a capacity. You&rsquo;ll get a public RSVP link, a dashboard link and a door
            link. No account, no email.
          </p>
          <Link href="/new" className="btn-primary mt-5 self-start">Create an event</Link>
        </Channel>
        <Channel n="02" title="Got an invite?">
          <OpenLink />
        </Channel>
        <Channel n="03" title="Your tickets">
          <MyTickets />
        </Channel>
        <Channel n="04" title="Your events">
          <MyEvents />
        </Channel>
      </div>
    </div>
  );
}
