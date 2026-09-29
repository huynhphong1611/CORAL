# fixtures/android

Synthetic UiAutomator2 dumps (`dumpWindowHierarchy`, SPEC §8.1, research R3) for unit tests of the
resolver, hit-test, hierarchy parser and popup guard — no device needed. Screen 1080 × 2400, app
`com.saucelabs.mydemoapp.android`; the status bar window (`com.android.systemui`) is always first in the file.

Window order in the XML carries no meaning, as on a device: u2 collects the window roots in a
HashSet (research R5). On a device the driver orders them by the window manager's z-order
(`dumpsys window windows`); for these files `hierarchy.ts` falls back to window classes — the
full-screen app window at the bottom, smaller windows (dialogs) above it, then the keyboard, the
status bar on top. Dialog windows have the dialog's size, as on the device (the permission dialog
is `[28,746][1052,1718]` on the Android 14 emulator); when a permission dialog is on top, a real
dump has no app window at all.

| File | Screen | Used for |
|---|---|---|
| `login.xml` | Login form (ids `nameET`, `passwordET`, `loginBtn`), bottom nav with 4 tabs (`content-desc`) | every locator type, `rel` (`below` "Mật khẩu"), `class_index` within `bottom_nav` |
| `list-scroll.xml` | Product list; items past y = 2240 have `visible-to-user="false"` | visibility filter, `scroll_to` |
| `permission-dialog.xml` | Runtime permission dialog from `com.google.android.permissioncontroller` on top of the app | popup guard rule `android_permission` |
| `rate-app-dialog.xml` | In-app dialog `android:id/parentPanel` "Đánh giá ứng dụng?" with "Để sau" | rule `rate_app` |
| `never-tap-only-dialog.xml` | In-app dialog whose only buttons are "Mua", "Thanh toán" | `never_tap` → `BLOCKED_BY_POPUP` |
| `crash-dialog.xml` | System dialog (package `android`) "keeps stopping", `aerr_close` | `APP_CRASHED`, never dismissed |
| `anr-dialog.xml` | System dialog "isn't responding", `aerr_wait` | `APP_NOT_RESPONDING`, never dismissed |
| `overlay-bottom-sheet.xml` | "Proceed To Checkout" button covered by a bottom sheet (higher `drawing-order`) | hit-test: target covered |
| `keyboard-open.xml` | Login form with the IME window over the bottom (y ≥ 1500); `nameET` focused | hit-test: bottom-nav tabs under the keyboard, `loginBtn` still tappable |

The files are hand-maintained. Once the device tests run on a real emulator, replace them with real
dumps of Sauce Labs My Demo App where the structure differs.
