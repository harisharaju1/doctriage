# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:24-alpine AS builder
WORKDIR /app

RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# ── Stage 2: runtime ────────────────────────────────────────────────────────
FROM node:24-alpine AS runner
WORKDIR /app

RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/dist ./dist

RUN mkdir -p uploads

EXPOSE 3000
ENV NODE_ENV=production

CMD ["node", "dist/server.js"]
