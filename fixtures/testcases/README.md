# fixtures/testcases

- `valid/` — files that must pass `coral validate` (SPEC §7, contracts/testcase-format.md).
  `all-actions.yaml` uses every action of §7.1.
- `invalid/` — one file per validation error; `invalid/expected.json` lists the error each file must
  produce (`code`, `path`, `step_id`) — SC-006.
- Reference test cases for Sauce Labs My Demo App (`mydemo-*.yaml`) are added with the device tasks.
