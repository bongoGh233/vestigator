# ---- Build stage: compile the React client ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json client/package.json
COPY server/package.json server/package.json
RUN npm ci
COPY client client
RUN npm run build --workspace client

# ---- Runtime stage: single Node server (API + socket + static client) ----
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json client/package.json
COPY server/package.json server/package.json
RUN npm ci --omit=dev
COPY server server
COPY --from=build /app/client/dist client/dist
RUN mkdir -p /app/server/data
EXPOSE 4001
VOLUME /app/server/data
CMD ["node", "server/index.js"]
