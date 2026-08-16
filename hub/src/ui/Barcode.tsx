import { useEffect, useRef, useState } from "react";

/**
 * The student number as a scannable CODE128 barcode.
 *
 * Same library and same pinned version the live app loads (index.html:4901), on
 * purpose: this is the one card that has to work at a lunch till, and a
 * hand-rolled encoder that is subtly wrong reads as a working barcode right up
 * until the scanner beeps twice at a child holding up a queue.
 *
 * IF THE LIBRARY DOES NOT LOAD, the number is shown at reading size with a line
 * saying the barcode could not be drawn. A blank white rectangle where a barcode
 * belongs is the failure this project keeps writing down: broken and empty look
 * the same, so neither is ever rendered alone.
 */

const JSBARCODE_CDN =
  "https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js";

type JsBarcodeFn = (
  el: SVGElement,
  value: string,
  opts: Record<string, unknown>,
) => void;

declare global {
  interface Window {
    JsBarcode?: JsBarcodeFn;
  }
}

let loader: Promise<void> | null = null;

function loadJsBarcode(): Promise<void> {
  if (window.JsBarcode) return Promise.resolve();
  if (loader) return loader;

  const p = new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = JSBARCODE_CDN;
    el.async = true;
    // Resolved when the script has EXECUTED, not when the tag exists.
    el.onload = () => (window.JsBarcode ? resolve() : reject(new Error("no JsBarcode")));
    el.onerror = () => reject(new Error("blocked or offline"));
    document.head.appendChild(el);
  });
  p.catch(() => {
    loader = null;
  });
  loader = p;
  return p;
}

export function Barcode({ value }: { value: string }) {
  const ref = useRef<SVGSVGElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadJsBarcode()
      .then(() => {
        if (cancelled || !ref.current || !window.JsBarcode) return;
        window.JsBarcode(ref.current, value, {
          format: "CODE128",
          displayValue: false,
          height: 78,
          margin: 0,
          lineColor: "#0E0E0E",
          background: "transparent",
        });
        // JsBarcode writes its own width/height attributes. CSS owns the box.
        ref.current.removeAttribute("width");
        ref.current.removeAttribute("height");
        ref.current.setAttribute("preserveAspectRatio", "none");
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [value]);

  if (failed) {
    return (
      <div className="rounded-[10px] bg-white px-4 py-3 text-center">
        <p className="font-mono text-[26px] font-bold tracking-[0.16em] text-wc-ink">
          {value}
        </p>
        <p className="mt-1 text-[11px] leading-snug text-wc-ink/60">
          The barcode image could not be loaded on this network. Read the number
          out or show this screen.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-[10px] bg-white px-3 py-2.5">
      <svg
        ref={ref}
        role="img"
        aria-label={`Barcode for student number ${value}`}
        className="block h-[74px] w-full"
      />
      <p className="mt-1 text-center font-mono text-[13px] font-bold tracking-[0.28em] text-wc-ink">
        {value}
      </p>
    </div>
  );
}
