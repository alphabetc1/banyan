// Exposes window.banyanDesktop to the room server's pages and the setup page.
import type { DesktopBridge, LocalRunnerStatus } from "@banyan/shared";
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

const bridge: DesktopBridge = {
  listRunners: () => ipcRenderer.invoke("runners:list"),
  enableRunner: (roomId, memberToken) => ipcRenderer.invoke("runners:enable", roomId, memberToken),
  disableRunner: (roomId) => ipcRenderer.invoke("runners:disable", roomId),
  onRunnersChanged: (listener) => {
    const handler = (_e: IpcRendererEvent, runners: LocalRunnerStatus[]) => listener(runners);
    ipcRenderer.on("runners:changed", handler);
    return () => ipcRenderer.off("runners:changed", handler);
  },
  setServerUrl: (url) => ipcRenderer.invoke("settings:server-url", url),
  notify: (title, body, path) => ipcRenderer.send("notify", title, body, path),
};

contextBridge.exposeInMainWorld("banyanDesktop", bridge);
