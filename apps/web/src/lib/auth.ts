export interface CurrentUser {
  email: string;
  name: string;
  sub: string;
  groups: string[];
}

const USER_STORAGE_KEY = "mabel-current-user";

function developmentUser(): CurrentUser {
  const email = import.meta.env.VITE_MABEL_DEV_USER_EMAIL || "developer@mabel.local";
  return {
    email,
    name: import.meta.env.VITE_MABEL_DEV_USER_NAME || "Mabel Developer",
    sub: import.meta.env.VITE_MABEL_DEV_USER_ID || email,
    groups: ["mabel-admins", "mabel-approvers"],
  };
}

export function getCurrentUser(): CurrentUser {
  try {
    const stored = window.localStorage.getItem(USER_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<CurrentUser>;
      if (parsed.email) {
        return {
          email: parsed.email,
          name: parsed.name || parsed.email,
          sub: parsed.sub || parsed.email,
          groups: Array.isArray(parsed.groups) ? parsed.groups : [],
        };
      }
    }
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
  return developmentUser();
}

export function setCurrentUser(user: CurrentUser): void {
  window.localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
}

export function clearCurrentUser(): void {
  window.localStorage.removeItem(USER_STORAGE_KEY);
}

export function getAuthHeaders(): Record<string, string> {
  const user = getCurrentUser();
  return {
    "Content-Type": "application/json",
    "X-User-Email": user.email,
    "X-User-Id": user.sub,
    "X-User-Name": user.name,
    "X-User-Groups": user.groups.join(","),
  };
}
