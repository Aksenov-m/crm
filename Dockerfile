FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.backend.json ./
COPY server ./server
COPY docs/015_create_self_hosted_backend_schema.sql ./docs/015_create_self_hosted_backend_schema.sql
RUN npm run backend:build

FROM node:22-alpine AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production PORT=3001 FILE_STORAGE_DIR=/app/data/uploads
WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./package.json
COPY --from=build --chown=node:node /app/dist/backend ./dist/backend
COPY --chown=node:node docs/015_create_self_hosted_backend_schema.sql ./docs/015_create_self_hosted_backend_schema.sql
RUN mkdir -p /app/data/uploads && chown -R node:node /app/data
USER node
EXPOSE 3001
CMD ["node", "dist/backend/server/index.js"]
