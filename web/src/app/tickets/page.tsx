"use client";

import { ActionHeader, Channel, MyTickets, OpenLink } from "@/components/console";

export default function Tickets() {
  return (
    <div className="mx-auto max-w-page px-4 sm:px-8">
      <ActionHeader eyebrow="The refund" title="Your tickets">
        Every ticket on this device. Check one to see whether it is listed, refunded or returned; open it to show its QR
        code at the door.
      </ActionHeader>
      <div className="mt-6 grid gap-5 md:grid-cols-[1.4fr_1fr]">
        <Channel n="03" title="On this device">
          <MyTickets />
        </Channel>
        <Channel n="02" title="RSVP to another">
          <OpenLink only="e" prompt="Paste an invite to get a new ticket." button="Find event" />
        </Channel>
      </div>
    </div>
  );
}
