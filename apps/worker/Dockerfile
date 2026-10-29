FROM node:22-slim
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile --filter @pulse/worker...
COPY apps/worker apps/worker
COPY packages packages
COPY targets.yaml ./
ENV NODE_ENV=production PORT=3001 TARGETS_FILE=/repo/targets.yaml
USER node
EXPOSE 3001
CMD ["pnpm", "--filter", "@pulse/worker", "start"]
