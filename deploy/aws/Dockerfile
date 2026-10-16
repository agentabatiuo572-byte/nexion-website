FROM node:24.19.0-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive PLAYWRIGHT_BROWSERS_PATH=/ms-playwright WRANGLER_SEND_METRICS=false WRANGLER_HIDE_BANNER=true
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund && npm ci --prefix schema --no-audit --no-fund && npm ci --prefix worker --no-audit --no-fund && npm ci --prefix admin --no-audit --no-fund
RUN npx --no-install playwright install --with-deps chromium
RUN node --no-maglev --test worker/aws/tests/*.test.mjs
RUN npm run build && npm run build:console && node worker/aws/build.mjs
RUN git config --system --add safe.directory /app && mkdir -p /app/node_modules/.astro /app/node_modules/.vite /app/node_modules/.vite-temp /app/admin/node_modules/.vite-temp /app/worker/node_modules/.vite-temp /app/admin/node_modules/.vite /app/worker/node_modules/.vite && chmod -R a+rX /app /ms-playwright
USER 10001:10001
CMD ["node", "worker/aws/server.mjs"]
