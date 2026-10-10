FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json prisma.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=5000 \
    STORAGE_DIR=/app/storage \
    MAX_FILE_SIZE_MB=25 \
    ALLOWED_DOCUMENT_TYPES=pdf,jpg,jpeg,png,webp \
    JWT_EXPIRES_IN=7d
LABEL com.azure.containerizationassist.createdby="containerization-assist"
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN addgroup -S -g 10001 appgroup \
    && adduser -S -D -H -u 10001 -G appgroup appuser \
    && mkdir -p /app/storage/documents /app/storage/temporary \
    && chown -R appuser:appgroup /app/storage
VOLUME ["/app/storage"]
USER appuser
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]

# Inject all credentials at runtime; never bake them into the image.
# DATABASE_URL=<set at runtime>
# JWT_SECRET=<set at runtime>
# GOOGLE_CLIENT_ID=<set at runtime>
# GOOGLE_CLIENT_SECRET=<set at runtime>
# GOOGLE_TOKEN_ENCRYPTION_KEY=<set at runtime>
# ADMIN_EMAIL=<set at runtime>
# ADMIN_PASSWORD=<set at runtime>
# GOOGLE_REDIRECT_URI=<set at runtime>
# GOOGLE_OAUTH_RETURN_URI=<set at runtime>
