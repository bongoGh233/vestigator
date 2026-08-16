# ---- Build stage: compile the React client ----
FROM node:22-alpine AS build
WORKDIR /app
# Prisma needs DATABASE_URL resolvable when generating the client; a dummy is
# fine here because generate never connects to a database.
ARG DATABASE_URL=postgresql://dummy:dummy@localhost:5432/dummy
ENV DATABASE_URL=$DATABASE_URL
COPY package.json package-lock.json ./
COPY client/package.json client/package.json
COPY server/package.json server/package.json
COPY prisma prisma
RUN npm ci
RUN npx prisma generate
COPY client client
RUN npm run build --workspace client

# ---- Runtime stage: single Node server (API + socket + static client) ----
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
ARG DATABASE_URL=postgresql://dummy:dummy@localhost:5432/dummy
ENV DATABASE_URL=$DATABASE_URL
COPY package.json package-lock.json ./
COPY client/package.json client/package.json
COPY server/package.json server/package.json
COPY prisma prisma
RUN npm ci --omit=dev
RUN npx prisma generate
COPY server server
COPY --from=build /app/client/dist client/dist
EXPOSE 4001
CMD ["node", "server/index.js"]
