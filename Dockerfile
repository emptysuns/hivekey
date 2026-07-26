FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

ENV DATA_DIR=/app/data
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME /app/data

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/health || exit 1

USER node
CMD ["node", "src/index.js"]
