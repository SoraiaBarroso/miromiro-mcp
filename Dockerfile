# stdio MCP server. Tools need MIROMIRO_API_KEY at call time (free key:
# https://miromiro.app/api/dashboard); the server starts and lists its tools without one.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV NODE_ENV=production
CMD ["node", "src/index.mjs"]
