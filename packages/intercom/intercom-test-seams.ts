import type { ExtensionContext } from "@orphus/coding-agent";
import type { Message, SessionInfo } from "./types.js";

export interface IntercomExtensionTestOverrides {
  captureInboundHandler?: (handler: (ctx: ExtensionContext, from: SessionInfo, message: Message) => void) => void;
}
