# PR #99556 current-head Gateway and Control UI proof

Exact PR source head: `acd73e4ea9e92aaf8348f58f22ca93173a4b6fa5`.

The proof ran in secretless fork GitHub Actions. The workflow verified that its
branch differed from the exact PR head only by the workflow and two focused
proof tests before installing dependencies or running source.

- Run: https://github.com/ly85206559/openclaw/actions/runs/33346920253
- Job: https://github.com/ly85206559/openclaw/actions/runs/33346920253/job/99352680406
- Proof harness commit: `77f839833375cefdd4be6f233d2bcd8e638d04d3`
- `pending-gateway-evidence.json`: a real WebSocket Gateway run staged a SQLite
  pending input, then proved that both `chat.history` and `chat.message.get`
  returned `{ type: "input_image", omitted: true, bytes: 34 }` without the raw
  data URL.
- `01-nested-history-omitted.png`: reloaded stored history shows the omission
  card and renders no history image.
- `02-live-image-preserved.png`: the same page keeps the omission card while a
  subsequent live image renders.
- `control-ui-proof.webm`: Chromium recording of the Control UI flow.
- `ui-evidence.json`: exact-head assertion counts and browser error results.

Gateway assertions:

```json
{
  "exactPrHead": "acd73e4ea9e92aaf8348f58f22ca93173a4b6fa5",
  "chatHistoryPendingContent": [{ "type": "input_image", "omitted": true, "bytes": 34 }],
  "chatMessageGetContent": [{ "type": "input_image", "omitted": true, "bytes": 34 }],
  "rawPayloadPresent": false
}
```

Control UI assertions:

```json
{
  "exactPrHead": "acd73e4ea9e92aaf8348f58f22ca93173a4b6fa5",
  "historyOmissionCards": 1,
  "historyRenderedImagesBeforeLive": 0,
  "liveRenderedImagesAfterEvent": 1,
  "pageErrors": []
}
```
