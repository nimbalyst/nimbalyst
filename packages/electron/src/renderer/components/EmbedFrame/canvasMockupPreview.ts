/** An SVG image renders HTML/CSS without starting an iframe, editor, or script. */
export function canvasMockupPreview(
  html: string,
  width: number,
  height: number
): string {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error("Preview dimensions must be positive.");
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc
    .querySelectorAll("script, iframe, object, embed, base, meta, link")
    .forEach((node) => node.remove());
  for (const element of doc.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      if (attribute.name.toLowerCase().startsWith("on"))
        element.removeAttribute(attribute.name);
    }
  }
  const style = doc.createElement("style");
  style.textContent = `html { width: ${width}px; height: ${height}px; overflow: hidden; }
    *, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }`;
  doc.head.appendChild(style);
  // SVG image mode does not load external resources or execute scripts. Keep
  // author HTML inside the image, never inject it into the workspace document.
  const content = new XMLSerializer().serializeToString(doc.documentElement);
  const scale = Math.min(1, 640 / width, 640 / height);
  const imageWidth = Math.max(1, Math.round(width * scale));
  const imageHeight = Math.max(1, Math.round(height * scale));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidth}" height="${imageHeight}" viewBox="0 0 ${width} ${height}"><foreignObject width="${width}" height="${height}">${content}</foreignObject></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Flatten once so zooming only composites a bounded bitmap, not HTML in SVG. */
export async function rasterizeCanvasMockupPreview(
  src: string
): Promise<string> {
  const image = new Image();
  image.src = src;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Preview image rendering is unavailable.");
  context.drawImage(image, 0, 0);
  return canvas.toDataURL("image/webp", 0.85);
}
