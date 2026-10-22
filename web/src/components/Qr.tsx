"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";

export function Qr({ value, size = 240, label }: { value: string; size?: number; label: string }) {
  const [svg, setSvg] = useState<string>("");
  useEffect(() => {
    QRCode.toString(value, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#0E1116", light: "#FFFFFF" } })
      .then(setSvg)
      .catch(() => setSvg(""));
  }, [value]);
  return (
    <div
      role="img"
      aria-label={label}
      className="overflow-hidden rounded-[4px] bg-white p-2 shadow-[0_0_0_1px_rgba(236,233,225,0.25)] [&_svg]:h-full [&_svg]:w-full"
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

// The image carries no event title: photo libraries sync to the cloud, and the
// QR alone is enough at the door.
export async function downloadQrPng(value: string, filename: string, caption = "cashr ticket") {
  const qr = document.createElement("canvas");
  await QRCode.toCanvas(qr, value, { width: 720, margin: 2, errorCorrectionLevel: "M" });
  const out = document.createElement("canvas");
  out.width = qr.width;
  out.height = qr.height + 120;
  const ctx = out.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(qr, 0, 0);
  ctx.fillStyle = "#0E1116";
  ctx.font = "600 34px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(caption, out.width / 2, qr.height + 60, out.width - 40);
  ctx.font = "24px system-ui, sans-serif";
  ctx.fillStyle = "#5B626D";
  ctx.fillText("Show this at the door", out.width / 2, qr.height + 98);
  const a = document.createElement("a");
  a.href = out.toDataURL("image/png");
  a.download = filename;
  a.click();
}
