# fixtures/testcases

- `valid/` — files that must pass `coral validate` (SPEC §7, contracts/testcase-format.md).
  `all-actions.yaml` uses every action of §7.1.
- `valid/image-locator.yaml` — `image` locators (short and long form); their images are in `snap/`,
  since the tests treat `fixtures/testcases/` as the project repo (`image_not_found`).
- `invalid/` — one file per validation error; `invalid/expected.json` lists the error each file must
  produce (`code`, `path`, `step_id`) — SC-006.
- `mydemo-*.yaml` — reference test cases for Sauce Labs My Demo App, run on an emulator by the device
  tasks: `mydemo-login.yaml` (SC-001, SC-002), `mydemo-camera-permission.yaml` (SC-003: the camera
  permission dialog must be allowed by the popup guard).
