import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
} from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export default defineBundledChannelEntry({
  id: "telegram",
  name: "Telegram",
  description: "Telegram channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "telegramPlugin",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
  runtime: {
    specifier: "./runtime-setter-api.js",
    exportName: "setTelegramRuntime",
  },
  accountInspect: {
    specifier: "./account-inspect-api.js",
    exportName: "inspectTelegramReadOnlyAccount",
  },
  registerFull(api) {
    const registerTelegramMiniApp = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(
      import.meta.url,
      { specifier: "./miniapp-api.js", exportName: "registerTelegramMiniApp" },
    );
    registerTelegramMiniApp(api);
  },
});
