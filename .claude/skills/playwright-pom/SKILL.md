---
name: playwright-pom
description: Use when creating or updating Playwright page objects or specs in this repo, or when asked to review a Playwright test. Follows the SimpleSchool test conventions.
---

# SimpleSchool Playwright conventions

## Structure
- Page objects: `tests/pages/<name>.page.ts`, one class per screen, named `<Name>Page`.
- Specs: `tests/specs/<area>.spec.ts`.
- Always import `test` and `expect` from `../fixtures` (never from `@playwright/test` directly)
  so tests get the `school`, `adminApi`, `adminPage` and `loginAs` fixtures.
- Use `adminApi` for data setup (fast), the browser only for the behaviour under test.

## Generating a page object
1. Open the matching EJS view in `views/` and the route in `routes/` to find real fields and URLs.
2. Locators: prefer `getByRole`, `getByLabel`, `getByText`; use CSS only if nothing else works. No XPath.
3. Expose actions as async methods (`addStudent(data)`), and expose locators as readonly properties.
4. No assertions inside page objects except `waitFor` style readiness checks.
5. TypeScript: type every method's parameters; no `any`.

## Writing or reviewing a spec – checklist
- Each test creates its own data (fresh school via fixtures); no dependence on other tests.
- Web-first assertions only (`await expect(locator).toBeVisible()`), never `waitForTimeout`.
- One behaviour per test; the title says the expected outcome.
- Cover the negative path (validation error, wrong role, other school's data) as well as the happy path.
- For multi-tenant features, add a check that School A cannot read or change School B's data.
- No real WhatsApp or email: the test server disables them; never re-enable in tests.
- When reviewing, report: problems found, flakiness risks, missing negative/isolation cases,
  and give the corrected code.