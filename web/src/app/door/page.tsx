"use client";

import { ActionHeader, Channel, MyEvents, OpenLink } from "@/components/console";

export default function DoorIndex() {
  return (
    <div className="mx-auto max-w-page px-4 sm:px-8">
      <ActionHeader eyebrow="The door" title="Check people in">
        Open the scanner on the phone at the entrance. It reads ticket QR codes, works offline, and never learns a name.
      </ActionHeader>
      <div className="mt-6 grid gap-5 md:grid-cols-2">
        <Channel n="06" title="Paste a door link">
          <OpenLink only="door" prompt="The organiser shares a door link that ends in #k=…" placeholder="https://…/door/abc123defg#k=…" button="Start scanning" />
        </Channel>
        <Channel n="04" title="Your events">
          <MyEvents mode="door" />
        </Channel>
      </div>
    </div>
  );
}
