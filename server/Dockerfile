# Build context: the repository root (the server shares src/core with the app).
#   docker build -f server/Dockerfile .

FROM node:22-alpine AS build
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --ignore-scripts && npm rebuild esbuild
COPY src/core /app/src/core
COPY server/ ./
RUN npm run build

# Runtime: one bundled file plus the SQL migrations, no node_modules.
FROM node:22-alpine
ENV NODE_ENV=production MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=build /app/server/dist/index.js ./index.js
COPY server/migrations ./migrations
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "index.js"]
