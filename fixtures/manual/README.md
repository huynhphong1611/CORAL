# fixtures/manual

Manual test cases to import (US6, contracts/manualcase.md).

- `login-en.csv` — comma, English headers, numbered steps and expected results in one cell.
- `vi-semicolon.csv` — UTF-8 with BOM, `;`, Vietnamese headers, a row without a title adding a step.
- `errors.csv` — a step with no test case above it (`missing_title`), a test case with no step (`missing_steps`), one valid case.
- `mydemo.xlsx` — sheet `Cases` (numbers, dates, numbered steps, a row without a title) and sheet `Login` (Vietnamese headers). A minimal OOXML file written by hand (zip of the sheet XML), no Excel needed.
- `shop.feature` — Background, Given/When/Then with `And`, a doc string, a Scenario Outline with two example rows, a scenario with no When (`missing_steps`).
- `broken.feature` — a data table with a missing cell (syntax error at line 10) between two valid scenarios.
- `vi.feature` — `# language: vi`.
