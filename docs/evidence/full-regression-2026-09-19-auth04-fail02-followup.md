# Full regression browser evidence — AUTH-04 registration validation and FAIL-02 recovery

- Date: 2026-09-19 (Asia/Singapore)
- Environment: local Compose stack at `http://127.0.0.1:3000/`; browser actions used CUA as the Jev fallback for native form verification.
- Scope: synthetic probes only; no production source changes.

## AUTH-04 registration probe

The static source currently checked in (`agent/src/application/browser-auth-service.ts`) contains a 6–128 character password check. The live browser path did not match that expectation:

1. While logged out, the Register form was submitted with a synthetic username and a one-character password. The UI authenticated a new ordinary `User` account instead of rejecting the field. The visible result was `Registered as adminauth04-invalid-20260919`.
2. The account was immediately logged out. It was not used for work and was not deleted because deletion is a destructive cleanup action requiring separate confirmation.
3. A second intended duplicate-username probe was invalidated by form-state handling: the text field retained an `admin` prefix and the paste appended to it, creating another ordinary synthetic account shown as `adminadminnot-an-email`. This was an operator/form interaction mistake, not evidence that duplicate registration is accepted. It was immediately logged out and not used.
4. No additional registration attempts were made. The original B browser account could not be restored through the UI after logout: the form showed `Invalid credentials` for the known test attempt. No password or credential value is recorded here.

Assessment: **AUTH-04 PARTIAL/FAILED validation branch**. The observed live acceptance of a one-character password conflicts with the checked-in validation contract, so the invalid-input branch is not a pass. The browser capture does confirm the new accounts were assigned the ordinary `User` role rather than admin. The duplicate-username and cross-process registration race branches remain unverified.

## FAIL-02 missing-path and recovery probe

Authenticated ordinary user `root@admin.comrt-20260919-a` sent:

> `Synthetic FAIL-02 missing-path probe. Call the read tool exactly once on the clearly nonexistent path /tmp/jev-regression-nonexistent-20260919/input.txt. Do not read any other path, do not write, do not call MCP. Report only the error category and answer FAIL02_MISSING_PATH_REJECTED.`

Observed in the conversation UI:

- sandbox label: `2CFDN1`
- Run status: `Succeeded · 1 tool · 1s` (the model handled the tool error and produced a terminal answer)
- tool/model response: `Error category: not found (missing path).`
- exact answer marker: `FAIL02_MISSING_PATH_REJECTED`
- no other path, write, MCP call, or persistent output was observed

The same conversation then received a recovery prompt with no tools and returned `FAIL02_RECOVERY_OK`. The follow-up Run visibly converged to `Succeeded · 778 ms`; the conversation did not remain stuck in Running or error state.

Assessment: **FAIL-02 PARTIAL, strengthened**. A real missing-path tool failure was classified without fabricating a successful read, and a same-conversation follow-up recovered. Corrupted Office/empty/MIME upload branches and a non-zero bash validation script remain untested.

