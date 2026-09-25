# Multi-stage build for a pnpm-workspace monorepo. Build context must be
# the REPO ROOT (not this directory), so this package can `COPY` its
# workspace dependencies -- see the docker build command in
# infra/terraform/README.md.
#
#   docker build -f apps/alert-service/Dockerfile -t alert-service .

FROM node:20-slim AS base
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# ---- deps: install once, leveraging the workspace lockfile ----
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.json ./
COPY packages/shared-types/package.json packages/shared-types/package.json
COPY packages/gcp-clients/package.json packages/gcp-clients/package.json
COPY apps/alert-service/package.json apps/alert-service/package.json
RUN pnpm install --frozen-lockfile --filter @vayusetu/alert-service...

# ---- build: bring in full source, compile shared-types' dist output ----
FROM deps AS build
COPY packages/shared-types packages/shared-types
COPY packages/gcp-clients packages/gcp-clients
COPY apps/alert-service apps/alert-service
RUN pnpm --filter @vayusetu/shared-types build
RUN pnpm --filter @vayusetu/alert-service build

# ---- runtime ----
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/alert-service
EXPOSE 8080
CMD ["pnpm", "start"]
