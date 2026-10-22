"use client";

import Link from "next/link";

import { ActionHeader, Channel, MyEvents, OpenLink } from "@/components/console";

export default function Events() {
  return (
    <div className="mx-auto max-w-page px-4 sm:px-8">
      <ActionHeader eyebrow="Organisers" title="Your events">
        Open a dashboard to watch RSVPs arrive, close RSVPs, refund everyone who came, see exactly what a seized server
        would reveal, and purge it all.
      </ActionHeader>
      <div className="mt-6 grid gap-5 md:grid-cols-[1.4fr_1fr]">
        <Channel n="04" title="Remembered here">
          <MyEvents />
        </Channel>
        <div className="grid gap-5">
          <Channel n="05" title="Open a dashboard">
            <OpenLink only="manage" prompt="Paste the manage link you saved when you created the event." placeholder="https://…/manage/abc123defg#k=…" button="Open dashboard" />
          </Channel>
          <Channel n="01" title="New event">
            <p className="text-sm text-ink-2">Deposit, capacity, done. No account.</p>
            <Link href="/new" className="btn bg-gold mt-5 self-start text-gold-on hover:bg-gold/90">Create an event</Link>
          </Channel>
        </div>
      </div>
    </div>
  );
}
