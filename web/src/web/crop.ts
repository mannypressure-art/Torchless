// Crop step for jar photos (JarCrop.swift): drag to move, pinch (or wheel) to zoom, inside a square.
// Output is a 1600 x 1600 JPEG of exactly what the square shows. Screens only.

import { h } from "./jar-ui";

const MAX_SRC = 2400;   // iOS caps canvas area (~16.7 MP), so the source is scaled down before cropping
const MAX_ZOOM = 5;

async function loadScaled(file: Blob): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("image")); img.src = url; });
    const k = Math.min(1, MAX_SRC / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally { URL.revokeObjectURL(url); }
}

/** Shows FRAME IT over the app. Resolves with the cropped JPEG, or null when cancelled. */
export async function cropPhoto(file: Blob): Promise<Blob | null> {
  const src = await loadScaled(file);
  const W = src.width, H = src.height;
  return new Promise(resolve => {
    let zoom = 1, ox = 0, oy = 0;
    const view = h("canvas", { class: "cropView" }) as HTMLCanvasElement;
    const wrap = h("div", { class: "cropWrap" }, view, h("div", { class: "cropGrid" }));
    const finish = (b: Blob | null) => { root.remove(); document.body.classList.toggle("sheetOpen", !!document.getElementById("sheets")?.childElementCount); resolve(b); };
    const root = h("div", { class: "cropRoot" },
      h("div", { class: "cropBar" },
        h("button", { class: "textBtn", onclick: () => finish(null) }, "Cancel"),
        h("b", { class: "cond", style: "font-size:24px;letter-spacing:2px" }, "FRAME IT"),
        h("button", { class: "textBtn", style: "color:var(--gold);font-weight:700", onclick: () => {
          const out = document.createElement("canvas"); out.width = 1600; out.height = 1600;
          draw(out.getContext("2d")!, 1600);
          out.toBlob(b => finish(b), "image/jpeg", 0.82);
        } }, "Use it")),
      wrap,
      h("p", { class: "mono dim center", style: "font-size:11px" }, "Drag to move. Pinch to zoom."),
      h("button", { class: "btn2", style: "align-self:center;font-size:16px;letter-spacing:2px", onclick: () => { zoom = 1; ox = 0; oy = 0; paint(); } }, "RESET"));
    document.body.append(root);
    document.body.classList.add("sheetOpen");

    let side = 300;
    const shown = (z: number) => { const fill = side / Math.max(Math.min(W, H), 1); return { w: W * fill * z, h: H * fill * z }; };
    const clamp = () => {
      const s = shown(zoom);
      const mx = Math.max((s.w - side) / 2, 0), my = Math.max((s.h - side) / 2, 0);
      ox = Math.min(Math.max(ox, -mx), mx); oy = Math.min(Math.max(oy, -my), my);
    };
    function draw(ctx: CanvasRenderingContext2D, out: number) {
      const s = shown(zoom), k = out / side;
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, out, out);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(src, (side / 2 + ox - s.w / 2) * k, (side / 2 + oy - s.h / 2) * k, s.w * k, s.h * k);
    }
    function paint() {
      side = Math.min(wrap.clientWidth || 300, 520);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      view.width = Math.round(side * dpr); view.height = Math.round(side * dpr);
      view.style.width = view.style.height = side + "px";
      clamp();
      draw(view.getContext("2d")!, side * dpr);
    }
    requestAnimationFrame(paint);

    // Drag and pinch with pointer events (touch-action: none on the square).
    const pts = new Map<number, { x: number; y: number }>();
    let pinch: { d: number; z: number } | null = null;
    const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
    view.addEventListener("pointerdown", e => { view.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pts.size === 2) pinch = { d: dist(), z: zoom }; });
    view.addEventListener("pointermove", e => {
      const p = pts.get(e.pointerId); if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (pts.size >= 2 && pinch) { zoom = Math.min(Math.max(pinch.z * dist() / Math.max(pinch.d, 1), 1), MAX_ZOOM); }
      else if (pts.size === 1) { ox += dx; oy += dy; }
      paint();
    });
    const up = (e: PointerEvent) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; };
    view.addEventListener("pointerup", up); view.addEventListener("pointercancel", up);
    view.addEventListener("wheel", e => { e.preventDefault(); zoom = Math.min(Math.max(zoom * Math.exp(-e.deltaY / 400), 1), MAX_ZOOM); paint(); }, { passive: false });
    // Stop Safari's page pinch-zoom while framing.
    root.addEventListener("gesturestart", e => e.preventDefault());
  });
}
