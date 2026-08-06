type Attrs = Record<
  string,
  string | number | boolean | undefined | EventListener
>;

/**
 * Terse element factory. Keys starting with `on` bind listeners, everything
 * else becomes an attribute; `undefined` and `false` are skipped.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Array<Node | string | null | undefined> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) {
      continue;
    }
    if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      continue;
    }
    if (key === "class") {
      node.className = String(value);
      continue;
    }
    if (key === "text") {
      node.textContent = String(value);
      continue;
    }
    node.setAttribute(key, value === true ? "" : String(value));
  }

  for (const child of children) {
    if (child === null || child === undefined) {
      continue;
    }
    node.append(child);
  }

  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) {
    node.firstChild.remove();
  }
}

/** A labelled `<select>` built from `[value, label]` pairs. */
export function select(
  options: Array<[string, string]>,
  value: string,
  onChange: (value: string) => void,
): HTMLSelectElement {
  const node = el("select", { class: "control-select" });
  for (const [optionValue, label] of options) {
    const option = el("option", { value: optionValue, text: label });
    if (optionValue === value) {
      option.selected = true;
    }
    node.append(option);
  }
  node.addEventListener("change", () => onChange(node.value));
  return node;
}

export function checkbox(
  label: string,
  checked: boolean,
  onChange: (checked: boolean) => void,
): HTMLLabelElement {
  const input = el("input", { type: "checkbox" });
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  return el("label", { class: "control-check" }, [
    input,
    el("span", { text: label }),
  ]);
}

export function button(
  label: string,
  onClick: () => void,
  options: { primary?: boolean; title?: string } = {},
): HTMLButtonElement {
  return el("button", {
    class: options.primary ? "btn btn-primary" : "btn",
    title: options.title,
    text: label,
    onclick: onClick,
  });
}

/** Backs a canvas with the device pixel ratio so nothing renders blurry. */
export function sizeCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): CanvasRenderingContext2D {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas 2D context unavailable");
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return ctx;
}

/** Resolves a CSS custom property to its computed value. */
export function themeColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  return value || fallback;
}
