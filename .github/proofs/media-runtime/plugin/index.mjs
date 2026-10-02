import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import path from "node:path";

export default definePluginEntry({
  id: "proof-native-media",
  name: "Isolated native media proof",
  description: "Fork-only Gateway reply and HTTP image transport proof.",
  register(api) {
    let armed = false;
    let faults = 0;
    api.registerGatewayMethod("proof.ready", ({ respond }) => {
      respond(true, { ready: true, mode: api.registrationMode });
    }, { scope: "operator.read", profileAccess: "independent" });
    api.registerMediaUnderstandingProvider({
      get id() {
        if (armed) {
          faults += 1;
          api.logger.info("PROOF_UNRELATED_MEDIA_REGISTRY_FAULT");
          throw new Error("PROOF_UNRELATED_MEDIA_REGISTRY_FAULT");
        }
        return "proof-unused-audio";
      },
      capabilities: ["audio"],
    });
    api.registerGatewayMethod("proof.arm", ({ params, respond }) => {
      armed = params.armed === true;
      faults = 0;
      respond(true, { armed });
    }, { scope: "operator.write", profileAccess: "independent" });
    api.registerGatewayMethod("proof.nativeImage", async ({ params, respond }) => {
      const cfg = api.runtime.config.current();
      const workspace = cfg.agents.defaults.workspace;
      const ctx = {
        Body: `Describe the attached image. Proof case ${params.case}.`,
        RawBody: `Describe the attached image. Proof case ${params.case}.`,
        From: "proof-user",
        To: "proof-bot",
        Provider: "webchat",
        MessageChannel: "webchat",
        ChatType: "direct",
        SessionKey: `agent:main:proof-native:${params.case}`,
        CommandAuthorized: true,
        media: [{ path: path.join(workspace, "proof.png"), contentType: "image/png", workspaceDir: workspace }],
      };
      const replies = [];
      await api.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx,
        cfg,
        dispatcherOptions: { deliver: async (payload) => { replies.push(payload); } },
      });
      respond(true, { faults, decisions: ctx.MediaUnderstandingDecisions ?? [], replies });
    }, { scope: "operator.write", profileAccess: "independent" });
  },
});
