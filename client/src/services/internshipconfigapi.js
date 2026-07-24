const API_BASE = `${import.meta.env.VITE_API_URL}/api`;

// Must match TOKEN_STORAGE_KEY in App.jsx.
const TOKEN_STORAGE_KEY = 'ojt-auth-token';

function getToken() {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${getToken()}`,
  };
}

// --- Shared internship-config cache ----------------------------------------
// Same pattern as attendanceapi.js's logsCache: a single in-memory value,
// shared by every component that calls fetchInternshipConfig() (MetricHeader
// on mount, plus anywhere else that reads the config), so re-mounting or
// re-navigating to MetricHeader doesn't re-hit the network every time.
// Only cleared when saveInternshipConfig() actually writes a change, so the
// next fetch after a real edit pulls fresh data — everything else reuses
// what's already in memory for the page session.
let configCache = null;

export function invalidateInternshipConfigCache() {
  configCache = null;
}

// Backend uses camelCase { requiredHours, officialStartDate }; OJTDashboard
// uses { estimatedHours, startDate }. This is the one place that naming
// translation happens, same pattern as attendanceapi.js's 12h/24h bridge.
function mapConfigFromApi(config) {
  if (!config) return { estimatedHours: 0, startDate: '' };
  return {
    estimatedHours: config.required_hours ?? 0,
    startDate: config.official_start_date
      ? config.official_start_date.split?.('T')[0] || config.official_start_date
      : '',
  };
}

// Fetches the logged-in user's internship configuration. Returns
// { estimatedHours: 0, startDate: '' } if nothing has been saved yet —
// MetricHeader already renders "Set required hours" / "Set a start date"
// for those defaults, so this is a normal, expected first-time state.
export async function fetchInternshipConfig() {
  if (configCache) return { ...configCache };

  const res = await fetch(`${API_BASE}/internship-config`, {
    headers: authHeaders(),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load internship configuration');

  configCache = mapConfigFromApi(data.config);
  return { ...configCache };
}

// Upserts required hours + official start date. Single endpoint handles
// both first-time setup and later edits (backend does ON CONFLICT).
export async function saveInternshipConfig({ estimatedHours, startDate }) {
  const res = await fetch(`${API_BASE}/internship-config`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify({
      requiredHours: estimatedHours,
      officialStartDate: startDate,
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to save internship configuration');

  configCache = mapConfigFromApi(data.config);
  return { ...configCache };
}