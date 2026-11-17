// Exposes window.banyanDesktop to the room server's pages and the setup page.
import type { DesktopBridge, LocalRunnerStatus } from "@banyan/shared";
import type { TerminalPortMessage } from "./host-protocol.ts";
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
  localWorkspace: () => ipcRenderer.invoke("local:workspace"),
  pickRepository: (startIn) => ipcRenderer.invoke("repo:pick", startIn),
  openLocalWorkspace: () => ipcRenderer.send("open:local"),
  openTeamServer: () => ipcRenderer.send("open:team"),
  notify: (title, body, path) => ipcRenderer.send("notify", title, body, path),
  openTerminal: (roomId, agentId, onData, onClose) => {
    const { port1, port2 } = new MessageChannel();
    const post = (msg: TerminalPortMessage) => port1.postMessage(msg);
    port1.onmessage = (e: MessageEvent<TerminalPortMessage>) => {
      if (e.data.type === "data") onData(e.data.data);
      else if (e.data.type === "closed") onClose(e.data.reason);
    };
    ipcRenderer.postMessage("terminal:open", { roomId, agentId }, [port2]);
    return {
      write: (data) => post({ type: "input", data }),
      resize: (cols, rows) => post({ type: "resize", cols, rows }),
      close: () => {
        post({ type: "close" });
        port1.close();
      },
    };
  },
};

contextBridge.exposeInMainWorld("banyanDesktop", bridge);
