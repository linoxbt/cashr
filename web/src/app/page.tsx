import { TapeDeck } from "@/components/TapeDeck";
import { TAPES } from "@/components/tapes";

export default function Home() {
  return (
    <div className="flex min-h-[calc(100dvh-var(--bezel)*2-14rem)] w-full flex-col items-center justify-center pb-4">
      <h1 className="sr-only">Unlisted: RSVPs without a guest list</h1>
      <TapeDeck tapes={TAPES} />
    </div>
  );
}
