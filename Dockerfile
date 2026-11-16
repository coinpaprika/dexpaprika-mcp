# Runs the stdio MCP server. Pinned to the newest Node major CI tests against.
FROM node:22-alpine

WORKDIR /app

# Install from the lockfile, production dependencies only, no install scripts.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Only the server source goes into the image, never a local .env or the git tree.
COPY src ./src
RUN npm run build

USER node

CMD ["node", "dist/bin.js"]
