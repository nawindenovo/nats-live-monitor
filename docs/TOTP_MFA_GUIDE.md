# Portal TOTP MFA — operator guide

Companion to OpenAPI (`openapi-totp-mfa.yaml` / Swagger UI `/docs/totp-mfa`).
Swagger shows a short summary; this file has the full detail.

## Overview

Portal-backend APIs for **configurable TOTP (authenticator app) MFA on login only**.
Mounted at `/v1/mfa` (`server.js` → `app.use("/v1/mfa", mfaRoute)`).

Eligibility (all must be true):

1. `TOTP_ENABLED=true`
2. `user.userType` exact-match in `TOTP_ENABLED_ROLES` (e.g. `SYSTEM,ISO`)
3. `users.totpBypass === false` / `0`

If any fail → **legacy MFA** path (unchanged). Proxy login-as is **out of scope**.

## Authentication

### What these endpoints do **not** use

- **No** `Authorization: Bearer …` header on MFA challenge paths
- **No** API key from the browser / Swagger “Try it out”
- **No** cookie session for the MFA challenge (binding is request body + DB row)
- Swagger UI **Authorize** is unused (`security: []`)

### Pre-login stages

| Stage | Proof | Where it lives |
|-------|--------|----------------|
| 1. Password | `email` + AES-encrypted `password` (+ captcha / fingerprint when required) | `POST /validateLogin` body |
| 2. Pre-auth session | Response returns `id` (UUID). Later calls send same `id` + matching `email` | Request JSON body — **not** a header |
| 3. Second factor | Email OTP and/or 6-digit authenticator `code` | Request JSON body |
| 4. Terms (if required) | `isTermsCheck=true` + `UserRoleType` on the **final** factor call | Request JSON body |
| 5. Login complete | Response includes `accessToken` (JWT) | Use on **other** portal APIs only |

Server validates: `pwdVerified`, not expired, status `PENDING`/`ACTIVE`, correct `totpFlow` (`VERIFY` vs `ENROLL`). Wrong/expired `id` → **400**.

### After login (JWT)

```http
Authorization: Bearer <accessToken>
```

Do **not** send Bearer back to `/v1/mfa/validateLogin`, `/verifyOTP`, or `/totp/*`.

### Portal → Java MFA (server-only)

```http
X-API-Key: <TOTP_API_KEY>
```

Never exposed to FE or Swagger Try it out.

### Swagger “Try it out”

1. Select server (local portal-backend + `/v1/mfa`).
2. `POST /validateLogin` → copy `id`.
3. Paste `id` + `email` into later steps.
4. Fill OTP / 6-digit `code`.
5. On success, use `accessToken` on other APIs only.

## Rate limiting

Env format: `points,durationSeconds,blockSeconds` (IP-based Redis).

| Env | Default | Applied to |
|-----|---------|------------|
| `LOGIN_RATE_LIMIT` | `5,5,300` | `POST /validateLogin` |
| `RETRY_RATE_LIMIT` | `20,60,120` | `resendOTP`, `verifyOTP`, `/totp/verify`, `/totp/verify-setup` |

On exceed → **HTTP 429** with the standard “too many attempts…” message.

## Configuration

```bash
TOTP_ENABLED=true
TOTP_ENABLED_ROLES=SYSTEM,ISO
TOTP_SERVICE_URL=https://auth.denovosystem.tech/twoFactorAuth
TOTP_API_KEY=<secret>
MFA=ON
TERMS_ALLOW_USERS=["SYSTEM"]
LOGIN_RATE_LIMIT=5,5,300
RETRY_RATE_LIMIT=20,60,120
```

Java (fail-closed):

- `GET  {TOTP_SERVICE_URL}/api/v1/mfa/status/{userId}`
- `POST {TOTP_SERVICE_URL}/api/v1/mfa/setup`
- `POST {TOTP_SERVICE_URL}/api/v1/mfa/verify`
- `POST {TOTP_SERVICE_URL}/api/v1/mfa/verify-setup`

## Session model

| Column | Meaning |
|--------|---------|
| `totpApplicable` | `1` when TOTP rules applied at password-OK |
| `totpFlow` | `VERIFY` / `ENROLL` / `NULL` (legacy) |
| `totpEmailOtpVerified` | `1` after email OTP during enrollment |
| `pwdVerified` | `1` after password OK |
| `userId` / `email` | Bound identity |
| `expiry` / `status` | Must be unexpired and PENDING/ACTIVE |

## Ordered flows

### A) Enrolled

1. `POST /validateLogin` → `totpVerificationRequired` + session `id`
2. `POST /totp/verify` → terms if needed → JWT

### B) First-time enroll

1. `POST /validateLogin` → `totpEnrollmentRequired`
2. `POST /verifyOTP` → QR (`totpEnrollmentPending`)
3. Optional `POST /resendOTP`
4. `POST /totp/verify-setup` → terms if needed → JWT

### C) Legacy

`validateLogin` → optional email MFA → JWT (unchanged).

### Terms

Factors first, terms last before JWT. ENROLL email/QR steps skip terms; final TOTP calls may require `isTermsCheck=true`.

### Codes

Authenticator codes are exactly **6 digits**. No backup codes on portal APIs.
