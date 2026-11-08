const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// a finger is extended when its tip is farther from the wrist than its middle joint
const ext = (h, tip, pip) => d(h[tip], h[0]) > d(h[pip], h[0]) * 1.08;

// open palm = at least 3 of the 4 fingers extended
export function palmOpen(h) {
  return [ext(h, 8, 6), ext(h, 12, 10), ext(h, 16, 14), ext(h, 20, 18)].filter(Boolean).length >= 3;
}
