# Bot continuation

Synthetic T3B-21 Home capture, correction/proposal preservation and ordinary-answer control. This runner uses shared authenticated real-server MCP helpers and the server's actual Bot instructions/tools. It never starts or stops a server. Parent owns isolated homes, fixture PIDs, model credentials and every paid turn. Defaults: Codex gpt-6-luna, medium, three samples, concurrency one; no fallback or replacement samples.

From evals, first run one setup probe:

```
pnpm bot-continuation --base-dir /synthetic/baseline-home --out /synthetic/baseline-probe --case capture-and-continue --samples 1
```

Use the same harness checkout against baseline and candidate. No candidate-only continuation imports are required: a local wire subset decodes the observation. Missing `read_continuation` is an explicit failed capability/capture check, preserved with its original error, while answer checks still run. Failure to settle is a failed check after 40 bounded wait slices, not an unlimited wait or silent retry. Transport/setup failures remain infrastructure errors. Successful provider execution alone proves neither fulfillment nor capture.

For full runs omit --case and --samples. Output is append-only results.jsonl (checks, answer, persisted note/provenance and raw activity), metadata.json and manifest.json. Use fresh output folders for independent samples. --baseline points at an earlier results.jsonl and preserves it in metadata for comparison; do not mix baseline and candidate rows. Half or more failed samples fail a case. Grader tests: `vp test run evals/bot-continuation/run.test.ts` from the repository root.

For a real parent-controlled stop/reopen:

```
pnpm bot-continuation --phase capture --base-dir /synthetic/candidate-home --out /synthetic/capture
# Parent records exact server PID/home/head, stops its captured PID and reopens that same home.
pnpm bot-continuation --phase resume --manifest /synthetic/capture/manifest.json --base-dir /synthetic/candidate-home --out /synthetic/reopened --lifecycle-evidence /synthetic/restart-evidence.json
```

A runner restart alone is not server recovery. For native compaction, parent uses the real compaction action only on the manifest's synthetic Homes between capture and resume, records tool result and run/session identity in lifecycle evidence, then runs resume. Keep restart, compaction and unchanged-server control as separate evidence. Never compact a live Home. Do not substitute prompt replay for either lifecycle test.

Deterministic backend fixtures separately cover omitted saves after successful completion/reopen, fixed source boundaries including same-run steering, missing sources, decision section promotion, CAS/lost response, lifecycle and authoritative task statuses beyond the recent fifty. Those tests supplement observable model behavior and do not count as model or client acceptance.
