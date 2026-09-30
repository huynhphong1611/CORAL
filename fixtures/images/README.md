# fixtures/images

Screens and element crops for the `image` locator (Phase 2, US6, SC-005), drawn from
`fixtures/android/login.xml` by `renderTree` — regenerate with
`node --import tsx scripts/gen-image-fixtures.ts` after changing either.

| File | What | Expected from the matcher (threshold 0.85) |
|---|---|---|
| `login-screen.png` | login screen, 1080 × 2400 | `login-button.png` found at `[60,920][1020,1060]` |
| `login-button.png` | crop of `id/loginBtn` from `login-screen.png`, 960 × 140 | the template |
| `login-moved.png` | same button with a new id, 240 px lower | found at `[60,1160][1020,1300]` — structured locators miss it |
| `login-720.png` | the login screen drawn 720 px wide | the template resized by `screen_width: 1080` lands on the scaled place, but scores below 0.85 (the bitmap font does not scale linearly) — no match, no blind tap (research R12: one resize, no multi-scale search) |
| `login-no-button.png` | the login screen without the button | no match (best score below the threshold) |

`packages/runner/src/core/image/matcher.test.ts` also draws more screens: the button moved into
free space under a new id (found), a button of the same style with another label, the bottom
sheet of `overlay-bottom-sheet.xml`, dialogs over the login screen and the sample app's other
screens (no match).
