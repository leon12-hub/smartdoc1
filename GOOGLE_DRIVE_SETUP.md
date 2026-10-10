# Google Drive setup

The Drive integration is server-side. Google client credentials, OAuth codes,
access tokens, refresh tokens, the encryption key, and database credentials
must never be added to the Flutter or website source. Keep real values only in
the backend's ignored `.env` or the production secret manager.

## Development

1. Create or select a Google Cloud project.
2. Enable the **Google Drive API**.
3. Configure the OAuth consent screen. Add the `openid` and `email` identity
   scopes and `https://www.googleapis.com/auth/drive.file`. The Drive scope
   allows SmartDoc to create files and folders and to use files explicitly
   opened with the app; full `drive` access is not requested.
4. If the consent screen is in Testing, add the Google accounts that will test
   the app.
5. Create an OAuth client of type **Web application**. Add this exact local
   callback as an authorized redirect URI:
   `http://localhost:5000/api/google/drive/callback`.
   The callback belongs to the backend; do not register the mobile deep link as
   a Google redirect URI. Authorized JavaScript origins are not needed for the
   backend-only OAuth exchange.
6. Put the client ID and secret in `backend/.env`. Generate a new, private,
   32-byte encryption key for this environment:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   ```

   Configure `GOOGLE_TOKEN_ENCRYPTION_KEY` with that output. Do not reuse the
   JWT secret as the encryption key.
7. Use `GOOGLE_OAUTH_RETURN_URI=smartdoc://drive/callback` for Android. The
   Android package is `com.smartdoc.smartdoc_mobile`; the app handles the
   `smartdoc://drive/callback` link and never receives Google tokens.
8. Allow the development website origin in `CORS_ORIGIN`, normally
   `http://localhost:3000`.

Example variable names (placeholders only):

```dotenv
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:5000/api/google/drive/callback
GOOGLE_TOKEN_ENCRYPTION_KEY=
GOOGLE_OAUTH_RETURN_URI=smartdoc://drive/callback
ADMIN_GOOGLE_OAUTH_RETURN_URI=http://localhost:3000/admin/settings/authentication
ADMIN_GOOGLE_LOGIN_RETURN_URI=http://localhost:3000/admin/auth
ADMIN_GOOGLE_LOGIN_RETURN_URIS=http://localhost:3000/admin/auth,http://localhost:5173/
```

Without all four Google credentials/configuration values, the backend returns
a clear `503` for connect/Drive operations. The app remains usable for local
scanning and SmartDoc document storage.

## Administrator Google sign-in

The website's **Admin Access** page uses the backend Google OAuth flow; it does
not create public user accounts. To enable it:

1. Set `ADMIN_EMAIL` to the verified Google account that should have
   administrator access, and create that administrator record with
   `npm run admin:bootstrap`.
2. Configure the Google OAuth client values above and register the exact
   `GOOGLE_REDIRECT_URI` as an authorized redirect URI in Google Cloud.
3. Set `ADMIN_GOOGLE_LOGIN_RETURN_URIS` to the exact website callback URL(s).
   Local development defaults are
   `http://localhost:3000/admin/auth` (Next.js) and `http://localhost:5173/`
   (Vite). Add the production website's `/admin/auth` URL when deploying.
4. Restart the backend after changing its environment. Sign in at
   `/admin/auth` using the same verified Google account configured by
   `ADMIN_EMAIL`.

Keep the client secret, encryption key, and other credentials only in the
backend's ignored `.env` or the deployment secret manager. If Google sign-in
cannot start, check the backend response and confirm the client settings,
redirect URI, active administrator record, and callback allowlist; never put
secrets in frontend environment variables.

## OCR and text extraction

SmartDoc extracts readable text and a short summary with Gemini after a
document's **Extract text** action is requested. Set `GEMINI_API_KEY` in the
backend environment and restart the backend to enable this feature. A missing
key returns a clear `503`; local scanning and storage remain available.

## Production

- Use a dedicated production Google Cloud project and OAuth client.
- Publish/configure the consent screen as required by Google's current
  verification process. Do not rely on test-user mode for general availability.
- Serve the backend over HTTPS and set
  `GOOGLE_REDIRECT_URI=https://api.example.com/api/google/drive/callback`.
  Register that exact URI with Google.
- Set `GOOGLE_OAUTH_RETURN_URI` to the HTTPS website's fixed callback URL, or
  the registered SmartDoc mobile scheme when using the mobile app. This is
  server configuration, not a request-controlled redirect.
- Store the client secret, independent 32-byte encryption key, database URL,
  and JWT secret in the deployment platform's secret manager. Rotate the
  encryption key only as part of an explicit token re-encryption migration;
  existing tokens cannot be decrypted after an unplanned key change.
- Set the frontend origin in `CORS_ORIGIN`. Use HTTPS for the website and
  production API.

## API behavior

- `GET /api/google/drive/connect` creates a ten-minute, database-backed,
  single-use OAuth state bound to the verified anonymous session.
- `GET /api/google/drive/callback` consumes and validates state before
  exchanging the authorization code.
- `GET /api/google/drive/status` returns connection state and account email,
  never credentials.
- `POST /api/google/drive/reconnect` begins a fresh OAuth authorization.
- `POST /api/google/drive/disconnect` revokes the stored credential when
  possible and always removes SmartDoc's local encrypted copy. It never deletes
  Drive files.
- `GET` and `POST /api/google/drive/folders` list and create accessible
  folders.
- `POST /api/google/drive/upload` accepts a previously saved `documentId` or
  one multipart file. A new upload is first retained in SmartDoc's local
  storage. Failed Drive synchronization is recorded and can be retried.
- The admin settings page uses `GET /api/admin/google/drive/status` and the
  protected `POST /api/admin/google/drive/connect`, `/reconnect`, and
  `/disconnect` endpoints. Admin OAuth state is bound to the admin session,
  and the authorized Google email must match `ADMIN_EMAIL`.
- Once the admin Drive connection is active, newly created SmartDoc folders
  and newly uploaded files are mirrored under a `SmartDoc` folder in that
  Drive. Existing app content is not backfilled. Local copies remain in
  `backend/storage/` (or `/app/storage` in Docker), so mount persistent storage
  in production. Admin mirror status is tracked separately from user Drive
  uploads.
- Admin sign-in uses `POST /api/admin/auth/google/start`. Its Google callback
  verifies the configured administrator, creates the admin session, and stores
  the Drive grant. Web sign-in uses an HttpOnly cookie; Flutter uses a
  single-use callback code at `smartdoc://admin/callback`.
- `ADMIN_GOOGLE_OAUTH_RETURN_URI` is the fixed website destination after the
  backend OAuth callback. Use an HTTPS URL in production; only localhost HTTP
  is allowed for development.

OAuth start and callback endpoints are rate-limited. The rate limiter uses
in-process storage; multi-instance deployments should configure a shared
rate-limit store at the infrastructure layer.

## Current project coverage

The Flutter app has a system-browser OAuth flow, a SmartDoc deep-link callback,
connection status, folder create/select, and PDF synchronization. The Vite
`website/` app and the Next.js `frontend/` app both provide a web administrator
Google sign-in flow; each deployed web origin must be included in
`ADMIN_GOOGLE_LOGIN_RETURN_URIS`.
