// Where the backend (clip saving + share links) lives.
// Locally the backend serves this frontend itself, so the API is same-origin.
// On Vercel the frontend is static and the API runs on Render.
const LOCAL = ["localhost", "127.0.0.1", ""].includes(location.hostname);
export const API = LOCAL ? "" : "https://suitup-api.onrender.com";
