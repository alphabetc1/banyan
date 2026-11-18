// The right-click menu: cut, copy and paste in text fields (including the terminal, whose
// input xterm places under the pointer), copy for selected text, and links to open or copy.
import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

export interface ContextMenuActions {
  openExternal: (url: string) => void;
  copyText: (text: string) => void;
}

type Params = Pick<ContextMenuParams, "isEditable" | "selectionText" | "editFlags" | "linkURL">;

// Empty when there is nothing to offer, so no menu opens.
export function contextMenuTemplate(params: Params, zh: boolean, actions: ContextMenuActions): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  if (/^https?:/.test(params.linkURL)) {
    items.push(
      { label: zh ? "在浏览器中打开链接" : "Open Link in Browser", click: () => actions.openExternal(params.linkURL) },
      { label: zh ? "复制链接" : "Copy Link", click: () => actions.copyText(params.linkURL) },
    );
  }
  if (params.isEditable) {
    if (items.length > 0) items.push({ type: "separator" });
    items.push(
      { role: "cut", label: zh ? "剪切" : "Cut", enabled: params.editFlags.canCut },
      { role: "copy", label: zh ? "复制" : "Copy", enabled: params.editFlags.canCopy },
      { role: "paste", label: zh ? "粘贴" : "Paste", enabled: params.editFlags.canPaste },
      { type: "separator" },
      { role: "selectAll", label: zh ? "全选" : "Select All", enabled: params.editFlags.canSelectAll },
    );
  } else if (params.selectionText.trim()) {
    if (items.length > 0) items.push({ type: "separator" });
    items.push({ role: "copy", label: zh ? "复制" : "Copy" });
  }
  return items;
}
