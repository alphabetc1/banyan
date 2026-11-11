// React contexts shared across pages.
import { createContext, useContext } from "react";
import type { ThemePreference } from "./theme.ts";
import type { RoomStore } from "./room-store.ts";

export const ThemeContext = createContext<{ pref: ThemePreference; setPref: (p: ThemePreference) => void }>({ pref: "system", setPref: () => {} });

export const RoomContext = createContext<RoomStore | null>(null);

export function useRoomStore(): RoomStore {
  const store = useContext(RoomContext);
  if (!store) throw new Error("useRoomStore must be used inside a room page");
  return store;
}
