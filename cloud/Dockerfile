# ros.ai cloud: sign-in and the free hosted Ros. Build from this folder: docker build -t ros-ai-cloud cloud
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
EXPOSE 8080
# Tables are created or updated on every start, so a new deploy never needs a manual step.
CMD ["sh", "-c", "npx tsx src/migrate.ts && npx tsx src/index.ts"]
