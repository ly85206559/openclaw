# PR #99556 exact-head nested Control UI proof

Exact PR source head: `97bb40177d96e78751827286a17012c20a387326`.

The proof ran in secretless fork GitHub Actions with Chromium and the repository's real Control UI mocked-Gateway harness. The proof branch differed from the exact PR head only by the workflow and focused proof test; the workflow verified that boundary before installing or running source.

- Run: https://github.com/ly85206559/openclaw/actions/runs/33294066034
- Job: https://github.com/ly85206559/openclaw/actions/runs/33294066034/job/99210608014
- `01-nested-history-omitted.png`: a reloaded `chat.startup` transcript contains a nested `toolResult.content` block with `{ type: "input_image", omitted: true, bytes: 26 }`. The page renders one explicit omission card and zero message images.
- `02-live-image-preserved.png`: after a real `chat.send` request and mocked `chat` final event, the same page retains the nested-history omission card and renders one live OpenClaw banner data URL.
- `control-ui-proof.webm`: Chromium recording of the same flow.
- `evidence.json`: machine-readable assertion counts and exact PR SHA.

Assertions:

```json
{
  "exactPrHead": "97bb40177d96e78751827286a17012c20a387326",
  "historyOmissionCards": 1,
  "historyRenderedImagesBeforeLive": 0,
  "liveRenderedImagesAfterEvent": 1,
  "pageErrors": []
}
```
