# PR #99556 Control UI proof

Exact PR head: `40ed4fce5d71237df97cbcd1bccac72a82a93288`

This browser capture uses the exact-head `dist-runtime-build` artifact from
[OpenClaw CI run 33146690684](https://github.com/openclaw/openclaw/actions/runs/33146690684)
and the repository's real Control UI mock Gateway implementation.

- `01-reloaded-history-omitted.png`: a reloaded `chat.startup` transcript contains
  the canonical `{ type: "input_image", omitted: true, bytes }` block. The UI
  renders one explicit omission card and zero image elements.
- `02-live-image-remains-renderable.png`: after a real `chat.send` request, a live
  `chat` final event carries a safe repository banner data URL. The same page keeps
  the stored-history omission card and renders exactly one live image.
- `control-ui-proof.webm`: browser recording of the same flow.

Assertions from the successful capture:

```json
{
  "historyOmissionCards": 1,
  "historyRenderedImagesBeforeLive": 0,
  "liveRenderedImagesAfterEvent": 1,
  "pageErrors": []
}
```
