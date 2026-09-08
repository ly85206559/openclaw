const delayMs = Number(process.env.OPENCLAW_PROOF_INJECT_DELAY_MS ?? "90000");

setTimeout(() => {
  const error = Object.assign(new Error("PR 141163 transient DNS proof"), {
    code: "EAI_AGAIN",
  });
  process.stderr.write("[proof] PROOF_TRANSIENT_INJECTED code=EAI_AGAIN\n");
  void Promise.reject(error);
}, delayMs);
