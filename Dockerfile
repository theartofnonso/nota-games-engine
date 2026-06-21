# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

# Install all dependencies (devDeps needed for tsc)
COPY package*.json ./
RUN npm ci

# Compile TypeScript → dist/
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Stage 2: production ───────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled output from build stage
COPY --from=builder /app/dist ./dist

EXPOSE 3000
CMD ["node", "dist/index.js"]
