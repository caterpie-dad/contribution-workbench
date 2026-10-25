FROM node:22.23.4-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && mkdir -p runtime && chown -R node:node /app
USER node
EXPOSE 3100
CMD ["npm", "start"]
