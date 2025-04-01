# Generated by https://smithery.ai. See: https://smithery.ai/docs/config#dockerfile
FROM node:lts-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (skip prepare if necessary)
RUN npm install --ignore-scripts

# Copy the source code
COPY . .

# Build the project
RUN npm run build

# Expose port if necessary (not strictly needed for MCP over stdio, but if there's any network exposure, do it)

CMD ["node", "dist/bin.js"]
