// Minimal history-based router for the handful of Banyan pages.
import { useEffect, useState } from "react";

export type Route =
  | { page: "home" }
  | { page: "join"; roomId: string }
  | { page: "overview"; roomId: string }
  | { page: "agent"; roomId: string; agentId: string }
  | { page: "worktrees"; roomId: string }
  | { page: "findings"; roomId: string }
  | { page: "coordination"; roomId: string };

export function parseRoute(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "join" && parts[1]) return { page: "join", roomId: parts[1] };
  if (parts[0] === "rooms" && parts[1]) {
    const roomId = parts[1];
    if (parts[2] === "agents" && parts[3]) return { page: "agent", roomId, agentId: parts[3] };
    if (parts[2] === "worktrees") return { page: "worktrees", roomId };
    if (parts[2] === "findings") return { page: "findings", roomId };
    if (parts[2] === "coordination") return { page: "coordination", roomId };
    return { page: "overview", roomId };
  }
  return { page: "home" };
}

export function routePath(route: Route): string {
  switch (route.page) {
    case "home":
      return "/";
    case "join":
      return `/join/${route.roomId}`;
    case "overview":
      return `/rooms/${route.roomId}`;
    case "agent":
      return `/rooms/${route.roomId}/agents/${route.agentId}`;
    default:
      return `/rooms/${route.roomId}/${route.page}`;
  }
}

export function navigate(path: string): void {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return route;
}

// Anchor that navigates client-side; modified clicks keep normal browser behaviour.
export function linkProps(path: string): { href: string; onClick: (e: React.MouseEvent) => void } {
  return {
    href: path,
    onClick: (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      navigate(path);
    },
  };
}
