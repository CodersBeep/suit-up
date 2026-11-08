import { API } from "./config.js";

export const health = () => fetch(`${API}/api/health`).then(r => r.json());

export async function uploadClip(blob) {
  const f = new FormData();
  f.append("file", blob, "clip");
  const r = await fetch(`${API}/api/clips`, { method: "POST", body: f });
  if (!r.ok) {
    let detail = r.statusText;
    try { detail = (await r.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  const j = await r.json();
  // share pages are served by the backend
  return { ...j, share_url: (API || location.origin) + j.share_url };
}
