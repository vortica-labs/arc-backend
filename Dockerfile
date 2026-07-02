# ---------- Stage 1: Build ----------
FROM node:22-alpine AS build
WORKDIR /app

# Install deps first (layer caching)
COPY package*.json ./
RUN npm ci

# Copy source & compile TS → JS
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# ---------- Stage 2: Production ----------
FROM node:22-alpine AS runtime
WORKDIR /app

# Non-root user for security
RUN addgroup -S appgrp && adduser -S appusr -G appgrp

ENV NODE_ENV=production

# Download Amazon DocumentDB / RDS CA bundle for TLS connections
# (no-op if MONGODB_TLS is not set — the file is simply present but unused)
RUN apk add --no-cache curl ca-certificates ffmpeg && \
    curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
      -o /app/rds-ca-bundle.pem && \
    chmod 444 /app/rds-ca-bundle.pem

# Only production deps
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled output
COPY --from=build /app/dist ./dist

# Canonical legacy JS source. Compiled HTTP and queue workers both resolve this
# tree through backendRootPath so they cannot load different policy versions.
COPY --from=build /app/src/legacy-src ./src/legacy-src
COPY --from=build /app/scripts ./scripts

# Security: drop to non-root
USER appusr

EXPOSE 5001

# Graceful shutdown + heap limits
CMD ["node", "--max-old-space-size=1536", "dist/launcher.js"]
