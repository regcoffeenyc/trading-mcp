FROM node:22-alpine

WORKDIR /app

# Install dependencies first so code edits don't invalidate the layer.
COPY package.json ./
RUN npm install --omit=optional

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# The bot holds real risk; never run it as root.
RUN addgroup -S bot && adduser -S bot -G bot \
 && mkdir -p /app/data && chown -R bot:bot /app
USER bot

VOLUME ["/app/data"]
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
