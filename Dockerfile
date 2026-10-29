FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS runtime
LABEL org.opencontainers.image.title="Scorekeeper.co MCP stdio bridge" \
      org.opencontainers.image.vendor="Stormlight Ventures LLC" \
      org.opencontainers.image.licenses="MIT" \
      io.modelcontextprotocol.server.name="co.scorekeeper/scorekeeper"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/src ./dist/src
COPY --chown=node:node package.json LICENSE SECURITY.md ./
RUN mkdir -p /home/node/.config && chown node:node /home/node/.config
USER node
VOLUME ["/home/node/.config"]
ENTRYPOINT ["node", "dist/src/cli.js"]
CMD ["serve"]
