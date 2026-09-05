FROM node:22-bookworm-slim

WORKDIR /app

# ffmpeg (for /stream decrypt) + the system libs cloakbrowser's Chromium needs.
COPY package.json package-lock.json ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && npm ci \
  && npx playwright install-deps chromium \
  && rm -rf /var/lib/apt/lists/*

COPY . .

# cloakbrowser downloads its Chromium into the home cache on first launch; keep it writable.
# (Only chown the cache dir — a recursive chown of /app/node_modules is huge and needless;
# the node user just needs to read the app, which root-owned files already allow.)
RUN mkdir -p /home/node/.cloakbrowser && chown node:node /home/node/.cloakbrowser
USER node

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
