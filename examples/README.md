# examples

Reference files for the formats in `docs/SPEC.md`. From Phase 1 they are validated in tests.

| File | Format | SPEC |
|---|---|---|
| `testcase.example.yaml` | `coral/testcase@1` — a test case with fallback locator chains | §7 |
| `popups.example.yaml` | `coral/popups@1` — popup guard rules and `never_tap` | §9.2, §9.4 |
| `brains.example.yaml` | `coral/brains@1` — brain routing per role (Copilot opt-in, commented) | §14.3 |
| `brains.fake.yaml` | `coral/brains@1` — the scripted `fake` brains (dev, E2E, CI; needs `CORAL_BRAIN_FAKE=1`) | §14.3 |
| `mcp.example.yaml` | `coral/mcp@1` — MCP servers and the tools the AI may call | §14.5 |
| `skills/login-demo-account/` | a project skill: `SKILL.md` + `rules.yaml` (`coral/skill-rules@1`: test data, `never_tap`, `forbidden`, `allow_submit`) | §13 |
