# stdio MCP server. Tools need MIROMIRO_API_KEY at call time (free key:
# https://miromiro.app/api/dashboard); the server starts and lists its tools without one.
# package-lock.json is gitignored (published package), so install from package.json.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
ENV NODE_ENV=production
CMD ["node", "src/index.mjs"]
