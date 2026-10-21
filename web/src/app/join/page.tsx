"use client";

import { ActionHeader, Channel, MyTickets, OpenLink } from "@/components/console";

export default function Join() {
  return (
    <div className="mx-auto max-w-page px-4 sm:px-8">
      <ActionHeader eyebrow="The deposit" title="RSVP to an event">
        Paste the invite you were sent. You&rsquo;ll give a fresh refund address, pay the deposit from your Zcash wallet
        and get your ticket, without giving a name.
      </ActionHeader>
      <div className="mt-6 grid gap-5 md:grid-cols-[1.3fr_1fr]">
        <Channel n="02" title="Paste your invite">
          <OpenLink
            only="e"
            prompt="Invites look like …/e/abc123defg. A 10-character event code works too."
            button="Find event"
          />
        </Channel>
        <Channel n="03" title="Your tickets">
          <MyTickets />
        </Channel>
      </div>
    </div>
  );
}
