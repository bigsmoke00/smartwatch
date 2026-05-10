FROM node:20-alpine AS builder
WORKDIR /app
# build deps para compilar node-pty (terminal interativo) + bash/ss para discovery
RUN apk add --no-cache python3 make g++
COPY package*.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# bash, sudo, iproute2 (ss), procps (ps real), curl — necessários para terminal e discovery
RUN apk add --no-cache bash sudo iproute2 procps curl
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package*.json ./
USER node
CMD ["node", "dist/index.js"]
