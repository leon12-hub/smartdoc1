# SmartDoc backend

## Start

- `npm run dev` starts the TypeScript development server on `PORT` (5000 by default).
- `npm run build` compiles the backend; `npm start` runs the compiled server.
- `npm test` builds the backend and runs the token, upload-validation, and
  Google Drive security tests.

## Guest documents

The User Panel does not need a user account or login. Call `POST /api/session` once;
the API sets an HttpOnly guest cookie and returns an anonymous token. Non-browser
clients can send that token in the `x-anonymous-session` header. The token is
signed, expires after one year, and its owner identifier is stored with guest
folders and documents.

Guest endpoints:

- `GET /api/folders`, `POST /api/folders`, `GET /api/folders/:id`,
  `PUT /api/folders/:id`, `DELETE /api/folders/:id`
- `GET /api/folders/:id/documents`
- `GET /api/documents`, `POST /api/documents`, `GET /api/documents/:id`,
  `PUT /api/documents/:id`, `DELETE /api/documents/:id`
- `GET /api/documents/search?q=<query>`
- `POST /api/documents/upload` accepts one PDF/JPEG/PNG/WebP file up to 25 MB.
- `GET /api/documents/:id/download` and `/preview` stream owned files.
- `POST /api/documents/:id/analyze` starts OCR-style text extraction and a
  summary for an owned, locally stored document. Configure `GEMINI_API_KEY` to
  enable analysis; the website provides the extraction status and results.

Listing and search accept page/limit, folderId, status, fileType, sortBy
(`createdAt`, `name`, `fileSize`), and sortOrder (`asc`, `desc`) filters.
Uploaded files are stored under the backend's ignored `storage/documents/`
directory; in-progress files use `storage/temporary/`.
Set `STORAGE_DIR` to an absolute path to move this local storage elsewhere;
otherwise the backend-relative `storage/` directory is used.
The Docker image exposes `/app/storage` as a volume; production deployments
should mount a persistent volume there so local copies survive container
replacement. When the administrator's Google Drive is connected, newly created
folders and uploaded files are also mirrored under its `SmartDoc` folder.
Items created before the Drive connection are not backfilled. Sync state is
kept separately from a guest's personal Google Drive connection.
`MAX_FILE_SIZE_MB` defaults to 25 and is capped at 100. Configure the optional
`ALLOWED_DOCUMENT_TYPES` comma-separated extension allowlist in the environment.
The `.env.example` file documents these settings without replacing `.env`.
Google Drive OAuth and file/folder endpoints are documented in
[`GOOGLE_DRIVE_SETUP.md`](./GOOGLE_DRIVE_SETUP.md). Real Google credentials and
a private token-encryption key must be configured in the backend environment
before Drive operations can be used.

## Administrator access

Set `ADMIN_EMAIL`, `ADMIN_PASSWORD` (12–72 UTF-8 bytes), and optionally
`ADMIN_NAME` in the local environment, then run `npm run admin:bootstrap` once
to create the administrator record. Runtime administrator sign-in uses Google
OAuth and only accepts the verified `ADMIN_EMAIL` account. The same consent
connects the administrator's Google Drive. Admin sessions are checked against
PostgreSQL and are revoked by logout.

Set `ADMIN_GOOGLE_LOGIN_RETURN_URIS` to a comma-separated list of exact web
callback URLs for the deployed Next.js and Vite clients. Each client sends its
current callback URL, which is signed into OAuth state and accepted only when
it exactly matches this allowlist. Keep `ADMIN_GOOGLE_LOGIN_RETURN_URI` as the
legacy fallback; the defaults include the local Next.js and Vite development
URLs.

Administrator endpoints:

- `POST /api/admin/auth/google/start` begins web or mobile Google sign-in.
- `POST /api/admin/auth/google/complete` exchanges a short-lived mobile callback
  code for the administrator JWT.
- `GET /api/admin/auth/me`, `POST /api/admin/auth/logout`
- `GET /api/admin/dashboard`, `/users`, `/documents`, `/reports`, `/logs`,
  and `/settings`

There is no public-user registration or login endpoint. Configure
`CORS_ORIGIN` as a comma-separated allowlist when the frontend is not on one of
the local development origins.

## Prisma 8

- `npm run prisma:contract` emits `contract.json` and `contract.d.ts`.
- `npm run prisma:migration -- --name <migration-name>` plans a migration.
- `npm run prisma:db` applies planned migrations.
- `npm run prisma:studio` prints the live database schema; Prisma 8 does not
  provide a built-in graphical Studio.
