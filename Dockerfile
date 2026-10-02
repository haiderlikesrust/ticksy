# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor/bigint-buffer ./vendor/bigint-buffer
RUN npm ci --include=dev --no-audit --no-fund

FROM dependencies AS web-build
COPY . .
RUN npm run build

# Vite emits static assets; no frontend Node process is needed.
FROM nginx:1.28-alpine AS web
COPY deploy/web.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/dist /usr/share/nginx/html
EXPOSE 80

FROM dependencies AS server-dependencies
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS game
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4100
COPY --from=server-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node shared ./shared
COPY --chown=node:node vendor/bigint-buffer ./vendor/bigint-buffer
USER node
EXPOSE 4100
CMD ["node", "--import", "tsx", "server/index.ts"]

FROM nginx:1.28-alpine AS gateway
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
