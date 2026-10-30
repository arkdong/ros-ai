FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm exec vite build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    ROS_PUBLIC_DEMO=1 \
    ROS_DATA_DIR=/data/visitor-workspaces \
    PORT=8080
# Keep tsx and the existing runtime dependency set. No provider keys are built in.
COPY --from=build /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY --from=build /app/dist/client ./dist/client
COPY src/server ./src/server
COPY src/shared ./src/shared
# The public image contains only the demos' own material: the banking scenario's exact inputs, then the guided tours.
COPY examples/dutch-ai-adoption/analysis.py examples/dutch-ai-adoption/cbs-ai-size-2024.csv examples/dutch-ai-adoption/article.md ./examples/dutch-ai-adoption/
COPY examples/tutorial-results/banking.json ./examples/tutorial-results/banking.json
# The guided tours: the recorded research walk-through and date night (sample data, drawn map and pictures).
COPY examples/demo-workflow ./examples/demo-workflow
COPY examples/demo-date-night/places.json examples/demo-date-night/map.png ./examples/demo-date-night/
COPY examples/demo-date-night/photos ./examples/demo-date-night/photos
EXPOSE 8080
CMD ["node", "--import", "tsx", "src/server/index.ts"]
